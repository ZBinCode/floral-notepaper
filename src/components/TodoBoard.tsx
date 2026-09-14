import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { showToast } from "./Toast";
import {
  completeTodoItem,
  createTodoItem,
  createTodoList,
  createTodoTag,
  deleteTodoItem,
  deleteTodoList,
  deleteTodoTag,
  getTodoErrorMessage,
  listTodoItems,
  listTodoLists,
  listTodoTags,
  renameTodoList,
  reorderTodoItems,
  setTodoItemPinned,
  setTodoListDefaultTags,
  spawnTodoDue,
  updateTodoItem,
  updateTodoTag,
} from "../features/todos/api";
import type { TodoItem, TodoList, TodoTag } from "../features/todos/types";
import {
  TODO_TAG_PALETTE,
  buildReminderAt,
  filterTodoItemsByTag,
  groupTodoItems,
  reminderTimeValue,
  reorderIdsAfterDrop,
  saveRequestFromItem,
  todoCountdown,
  todoCountdownLabel,
  todoRecurrenceLabel,
  todoTagColor,
  toggleTagId,
} from "../features/todos/todoUtils";
import {
  closeCurrentWindow,
  setCurrentWindowAlwaysOnTop,
  startCurrentWindowDrag,
} from "../features/windows/controls";

interface DropTarget {
  listId: string;
  index: number;
}

export function TodoBoard() {
  const { t } = useTranslation();
  const [lists, setLists] = useState<TodoList[]>([]);
  const [items, setItems] = useState<TodoItem[]>([]);
  const [tags, setTags] = useState<TodoTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [creatingList, setCreatingList] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [dueEditingId, setDueEditingId] = useState<string | null>(null);
  const [tagEditingId, setTagEditingId] = useState<string | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const epochRef = useRef(0);

  const refresh = useCallback(() => {
    const epoch = ++epochRef.current;
    Promise.all([listTodoLists(), listTodoItems(), listTodoTags()])
      .then(([nextLists, nextItems, nextTags]) => {
        if (epochRef.current !== epoch) return;
        setLists(nextLists);
        setItems(nextItems);
        setTags(nextTags);
        setSelectedTagId((current) =>
          current && nextTags.some((tag) => tag.id === current) ? current : null,
        );
        setLoadError(null);
      })
      .catch((error) => {
        if (epochRef.current !== epoch) return;
        setLoadError(getTodoErrorMessage(error));
      })
      .finally(() => {
        if (epochRef.current === epoch) setLoading(false);
      });
  }, []);

  useEffect(() => {
    // 启动补跑：应用关闭期间错过的重复待办在此推进
    spawnTodoDue().catch(() => undefined);
    refresh();
    const unlisten = listen("todos-changed", () => refresh());
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      void unlisten.then((fn) => fn());
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const visibleItems = useMemo(
    () => filterTodoItemsByTag(items, selectedTagId),
    [items, selectedTagId],
  );
  const groups = useMemo(() => groupTodoItems(visibleItems, lists), [visibleItems, lists]);
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);

  const handleHeaderMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button,input,select,a")) return;
    if (event.button !== 0) return;
    void startCurrentWindowDrag().catch(() => undefined);
  };

  const handleToggleAlwaysOnTop = () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    setCurrentWindowAlwaysOnTop(next).catch(() => setAlwaysOnTop(!next));
  };

  const handleCreateList = async () => {
    const name = newListName.trim();
    if (!name) return;
    setCreatingList(true);
    try {
      await createTodoList({ name, defaultTagIds: [] });
      setNewListName("");
    } catch (error) {
      showToast(getTodoErrorMessage(error), "error");
    } finally {
      setCreatingList(false);
    }
  };

  const handleAddItem = async (listId: string) => {
    const title = (drafts[listId] ?? "").trim();
    if (!title) return;
    setDrafts((prev) => ({ ...prev, [listId]: "" }));
    try {
      await createTodoItem({
        listId,
        title,
        pinned: false,
        tagIds: [],
        dueDate: null,
        remindAt: null,
        recurrence: null,
      });
    } catch (error) {
      showToast(getTodoErrorMessage(error), "error");
    }
  };

  const handleComplete = async (item: TodoItem) => {
    try {
      await completeTodoItem(item.id);
      showToast(
        t("todo.item.completed", { defaultValue: "已完成「{{title}}」", title: item.title }),
        "info",
      );
    } catch (error) {
      showToast(getTodoErrorMessage(error), "error");
    }
  };

  const handleTogglePinned = async (item: TodoItem) => {
    try {
      await setTodoItemPinned(item.id, !item.pinned);
    } catch (error) {
      showToast(getTodoErrorMessage(error), "error");
    }
  };

  const handleDelete = async (item: TodoItem) => {
    try {
      await deleteTodoItem(item.id);
    } catch (error) {
      showToast(getTodoErrorMessage(error), "error");
    }
  };

  const commitTitleEdit = async (item: TodoItem) => {
    const title = (editing?.title ?? "").trim();
    setEditing(null);
    if (!editing || editing.id !== item.id || title === item.title || !title) return;
    try {
      await updateTodoItem(item.id, saveRequestFromItem(item, { title }));
    } catch (error) {
      showToast(getTodoErrorMessage(error), "error");
    }
  };

  const handleDueAndReminder = async (item: TodoItem, dueDate: string, time: string) => {
    setDueEditingId(null);
    const nextDue = dueDate || null;
    const remindAt = buildReminderAt(nextDue, time);
    if (nextDue === (item.dueDate ?? null) && remindAt === (item.remindAt ?? null)) return;
    try {
      await updateTodoItem(item.id, saveRequestFromItem(item, { dueDate: nextDue, remindAt }));
    } catch (error) {
      showToast(getTodoErrorMessage(error), "error");
    }
  };

  const handleSetItemTags = async (item: TodoItem, tagIds: string[]) => {
    try {
      await updateTodoItem(item.id, saveRequestFromItem(item, { tagIds }));
    } catch (error) {
      showToast(getTodoErrorMessage(error), "error");
    }
  };

  const handleCreateTagAndAssign = async (item: TodoItem, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const tag = await createTodoTag({ name: trimmed, color: "" });
      await handleSetItemTags(item, [...item.tagIds, tag.id]);
    } catch (error) {
      showToast(getTodoErrorMessage(error), "error");
    }
  };

  const handleDrop = async (listId: string, displayIds: string[], target: DropTarget) => {
    const dragId = dragItemId;
    setDragItemId(null);
    setDropTarget(null);
    if (!dragId) return;
    const orderedIds = reorderIdsAfterDrop(displayIds, dragId, target.index);
    if (orderedIds.join("\n") === displayIds.join("\n")) return;
    try {
      await reorderTodoItems(listId, orderedIds);
    } catch (error) {
      showToast(getTodoErrorMessage(error), "error");
    }
  };

  const handleEditKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, item: TodoItem) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitTitleEdit(item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditing(null);
    }
  };

  return (
    <div className="w-full h-screen flex flex-col bg-transparent">
      <div className="app-surface-frame relative noise-bg w-full h-full min-h-0 bg-cloud overflow-hidden flex flex-col border border-paper-deep/70 shadow-[0_1px_10px_rgba(26,26,24,0.06)]">
        <div
          className="flex items-center justify-between h-10 pl-3 pr-1.5 shrink-0 border-b border-paper-deep/30 bg-paper/55 select-none cursor-default"
          onMouseDown={handleHeaderMouseDown}
        >
          <span className="text-[13px] font-serif font-medium text-ink-soft tracking-wide">
            {t("todo.title", { defaultValue: "待办" })}
          </span>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setTagManagerOpen(true)}
              className="w-8 h-9 flex items-center justify-center text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer"
              title={t("todo.tags.manage", { defaultValue: "管理标签" })}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
                <circle cx="7.5" cy="7.5" r="0.5" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleToggleAlwaysOnTop}
              className={`w-8 h-9 flex items-center justify-center transition-all cursor-pointer ${
                alwaysOnTop
                  ? "text-bamboo bg-bamboo-mist/50"
                  : "text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50"
              }`}
              title={t("todo.window.pin", { defaultValue: "窗口置顶" })}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => void closeCurrentWindow().catch(() => undefined)}
              className="w-8 h-9 flex items-center justify-center text-ink-ghost hover:text-red-400 hover:bg-danger-bg/80 transition-all cursor-pointer"
              title={t("todo.window.close", { defaultValue: "关闭" })}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {tags.length > 0 && (
          <div className="flex items-center gap-1 px-2.5 py-1.5 shrink-0 border-b border-paper-deep/20 overflow-x-auto scrollbar-hidden">
            <TagFilterChip
              label={t("todo.tags.filterAll", { defaultValue: "全部" })}
              color={null}
              active={selectedTagId === null}
              onClick={() => setSelectedTagId(null)}
            />
            {tags.map((tag) => (
              <TagFilterChip
                key={tag.id}
                label={tag.name}
                color={todoTagColor(tag)}
                active={selectedTagId === tag.id}
                onClick={() => setSelectedTagId(selectedTagId === tag.id ? null : tag.id)}
              />
            ))}
          </div>
        )}

        <div className="relative flex-1 min-h-0 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="h-full flex items-center justify-center text-[12px] text-ink-faint">
              {t("todo.loading", { defaultValue: "加载中…" })}
            </div>
          ) : loadError ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 px-4 text-center">
              <span className="text-[12px] text-red-500">{loadError}</span>
              <button
                type="button"
                onClick={refresh}
                className="text-[12px] text-bamboo hover:underline cursor-pointer"
              >
                {t("todo.retry", { defaultValue: "重试" })}
              </button>
            </div>
          ) : groups.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-ink-ghost"
              >
                <path d="M3 5h12" />
                <path d="M7 6.5v13" />
                <path d="M5 19h6" />
                <path d="M14 9h7l-2 5h-3.5" />
                <path d="M14 9V5" />
              </svg>
              <div className="text-[12px] text-ink-faint">
                {selectedTagId
                  ? t("todo.empty.filtered", { defaultValue: "该标签下没有待办" })
                  : t("todo.empty.title", { defaultValue: "还没有清单" })}
                {!selectedTagId && (
                  <div className="mt-0.5 text-[11px] text-ink-ghost">
                    {t("todo.empty.hint", { defaultValue: "创建第一个清单，开始整理待办" })}
                  </div>
                )}
              </div>
              {!selectedTagId && (
                <NewListForm
                  value={newListName}
                  onChange={setNewListName}
                  onSubmit={handleCreateList}
                  submitting={creatingList}
                  autoFocus
                />
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((group) => (
                <TodoListSection
                  key={group.list.id}
                  list={group.list}
                  items={group.items}
                  tags={tags}
                  tagsById={tagsById}
                  draft={drafts[group.list.id] ?? ""}
                  onDraftChange={(value) =>
                    setDrafts((prev) => ({ ...prev, [group.list.id]: value }))
                  }
                  onAdd={() => void handleAddItem(group.list.id)}
                  editing={editing}
                  onEditingChange={setEditing}
                  onEditKeyDown={handleEditKeyDown}
                  onCommitTitle={(item) => void commitTitleEdit(item)}
                  onComplete={(item) => void handleComplete(item)}
                  onTogglePinned={(item) => void handleTogglePinned(item)}
                  onDelete={(item) => void handleDelete(item)}
                  onDueChange={(item, dueDate, time) =>
                    void handleDueAndReminder(item, dueDate, time)
                  }
                  onSetItemTags={(item, tagIds) => void handleSetItemTags(item, tagIds)}
                  onCreateTagAndAssign={(item, name) => void handleCreateTagAndAssign(item, name)}
                  onRenameList={async (id, name) => {
                    try {
                      await renameTodoList(id, name);
                    } catch (error) {
                      showToast(getTodoErrorMessage(error), "error");
                    }
                  }}
                  onSetDefaultTags={async (id, tagIds) => {
                    try {
                      await setTodoListDefaultTags(id, tagIds);
                    } catch (error) {
                      showToast(getTodoErrorMessage(error), "error");
                    }
                  }}
                  onDeleteList={async (id) => {
                    try {
                      await deleteTodoList(id);
                    } catch (error) {
                      showToast(getTodoErrorMessage(error), "error");
                    }
                  }}
                  dueEditingId={dueEditingId}
                  onDueEditingChange={setDueEditingId}
                  tagEditingId={tagEditingId}
                  onTagEditingChange={setTagEditingId}
                  dragItemId={dragItemId}
                  dropTarget={dropTarget}
                  onDragItemChange={setDragItemId}
                  onDropTargetChange={setDropTarget}
                  onDrop={(displayIds, target) =>
                    void handleDrop(group.list.id, displayIds, target)
                  }
                />
              ))}
              <NewListForm
                value={newListName}
                onChange={setNewListName}
                onSubmit={handleCreateList}
                submitting={creatingList}
                compact
              />
            </div>
          )}
        </div>

        {tagManagerOpen && (
          <TagManagerDialog
            tags={tags}
            onClose={() => setTagManagerOpen(false)}
            onCreateTag={async (name, color) => {
              await createTodoTag({ name, color });
            }}
            onUpdateTag={async (id, name, color) => {
              await updateTodoTag(id, { name, color });
            }}
            onDeleteTag={async (id) => {
              await deleteTodoTag(id);
            }}
          />
        )}
      </div>
    </div>
  );
}

function NewListForm({
  value,
  onChange,
  onSubmit,
  submitting,
  compact = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  submitting: boolean;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={`flex items-center gap-1.5 ${compact ? "px-1 py-1" : "w-56"}`}>
      <input
        value={value}
        autoFocus={autoFocus}
        disabled={submitting}
        placeholder={t("todo.list.namePlaceholder", { defaultValue: "清单名称" })}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void onSubmit();
          }
        }}
        className="flex-1 min-w-0 h-7 px-2 rounded-md bg-paper/70 border border-paper-deep/40 text-[12px] text-ink placeholder:text-ink-ghost focus:outline-none focus:border-bamboo/60"
      />
      <button
        type="button"
        disabled={submitting || !value.trim()}
        onClick={() => void onSubmit()}
        className="h-7 px-2.5 rounded-md bg-bamboo/90 text-white text-[12px] disabled:opacity-40 hover:bg-bamboo transition-colors cursor-pointer"
      >
        {t("todo.list.create", { defaultValue: "创建" })}
      </button>
    </div>
  );
}

function TagFilterChip({
  label,
  color,
  active,
  onClick,
}: {
  label: string;
  color: string | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 h-6 px-2 rounded-full border text-[11px] shrink-0 transition-colors cursor-pointer ${
        active
          ? "border-bamboo/70 bg-bamboo-mist/60 text-ink"
          : "border-paper-deep/40 bg-paper/50 text-ink-faint hover:text-ink"
      }`}
    >
      {color && (
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
      )}
      <span className="max-w-[96px] truncate">{label}</span>
    </button>
  );
}

interface TodoListSectionProps {
  list: TodoList;
  items: TodoItem[];
  tags: TodoTag[];
  tagsById: Map<string, TodoTag>;
  draft: string;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  editing: { id: string; title: string } | null;
  onEditingChange: (editing: { id: string; title: string } | null) => void;
  onEditKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>, item: TodoItem) => void;
  onCommitTitle: (item: TodoItem) => void;
  onComplete: (item: TodoItem) => void;
  onTogglePinned: (item: TodoItem) => void;
  onDelete: (item: TodoItem) => void;
  onDueChange: (item: TodoItem, dueDate: string, time: string) => void;
  onSetItemTags: (item: TodoItem, tagIds: string[]) => void;
  onCreateTagAndAssign: (item: TodoItem, name: string) => void;
  onRenameList: (id: string, name: string) => Promise<void>;
  onSetDefaultTags: (id: string, tagIds: string[]) => Promise<void>;
  onDeleteList: (id: string) => Promise<void>;
  dueEditingId: string | null;
  onDueEditingChange: (id: string | null) => void;
  tagEditingId: string | null;
  onTagEditingChange: (id: string | null) => void;
  dragItemId: string | null;
  dropTarget: DropTarget | null;
  onDragItemChange: (id: string | null) => void;
  onDropTargetChange: (target: DropTarget | null) => void;
  onDrop: (displayIds: string[], target: DropTarget) => void;
}

function TodoListSection(props: TodoListSectionProps) {
  const { t } = useTranslation();
  const { list, items } = props;
  const displayIds = items.map((item) => item.id);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(list.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const rowDragOver = (event: ReactDragEvent<HTMLElement>, displayIndex: number) => {
    if (!props.dragItemId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const after = event.clientY - bounds.top > bounds.height / 2;
    props.onDropTargetChange({ listId: list.id, index: displayIndex + (after ? 1 : 0) });
  };

  const containerDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!props.dragItemId) return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    props.onDropTargetChange({ listId: list.id, index: items.length });
  };

  const showIndicator = (index: number) =>
    props.dropTarget?.listId === list.id && props.dropTarget.index === index && props.dragItemId;

  const commitRename = () => {
    const name = renameDraft.trim();
    if (name && name !== list.name) {
      void props.onRenameList(list.id, name);
    } else {
      setRenameDraft(list.name);
    }
  };

  return (
    <section className="rounded-xl bg-paper/40 border border-paper-deep/30 overflow-hidden">
      <header className="group flex items-center justify-between pl-2.5 pr-1.5 pt-2 pb-1 gap-1">
        {settingsOpen ? (
          <input
            autoFocus
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setRenameDraft(list.name);
                setSettingsOpen(false);
              }
            }}
            className="flex-1 min-w-0 h-6 px-1.5 rounded-md bg-paper border border-bamboo/50 text-[12px] font-medium text-ink focus:outline-none"
          />
        ) : (
          <span className="text-[12px] font-medium text-ink-soft truncate">{list.name}</span>
        )}
        <div className="flex items-center gap-1 shrink-0">
          {list.defaultTagIds.length > 0 && !settingsOpen && (
            <div className="flex items-center gap-0.5">
              {list.defaultTagIds.slice(0, 4).map((tagId) => {
                const tag = props.tagsById.get(tagId);
                if (!tag) return null;
                return (
                  <span
                    key={tagId}
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: todoTagColor(tag) }}
                    title={t("todo.list.defaultTags", {
                      defaultValue: "默认标签：{{tags}}",
                      tags: list.defaultTagIds
                        .map((id) => props.tagsById.get(id)?.name ?? "")
                        .filter(Boolean)
                        .join("、"),
                    })}
                  />
                );
              })}
            </div>
          )}
          <span className="text-[10px] text-ink-ghost">{items.length}</span>
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(!settingsOpen);
              setRenameDraft(list.name);
              setConfirmingDelete(false);
            }}
            className={`w-5 h-5 flex items-center justify-center rounded transition-colors cursor-pointer ${
              settingsOpen
                ? "text-bamboo bg-bamboo-mist/60"
                : "text-ink-ghost/0 group-hover:text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/60"
            }`}
            title={t("todo.list.settings", { defaultValue: "清单设置" })}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="1" />
              <circle cx="19" cy="12" r="1" />
              <circle cx="5" cy="12" r="1" />
            </svg>
          </button>
        </div>
      </header>

      {settingsOpen && (
        <div className="mx-1.5 mb-1.5 p-2 rounded-lg bg-paper/70 border border-paper-deep/40 flex flex-col gap-2">
          <div>
            <div className="text-[10px] text-ink-ghost mb-1">
              {t("todo.list.defaultTagsHint", { defaultValue: "在此清单新建待办时自动附加" })}
            </div>
            {props.tags.length === 0 ? (
              <div className="text-[11px] text-ink-ghost">
                {t("todo.tags.empty", { defaultValue: "还没有标签" })}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {props.tags.map((tag) => {
                  const active = list.defaultTagIds.includes(tag.id);
                  const color = todoTagColor(tag);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() =>
                        void props.onSetDefaultTags(
                          list.id,
                          toggleTagId(list.defaultTagIds, tag.id),
                        )
                      }
                      className={`flex items-center gap-1 h-6 px-2 rounded-full border text-[11px] transition-colors cursor-pointer ${
                        active ? "text-ink" : "text-ink-faint hover:text-ink"
                      }`}
                      style={{
                        borderColor: color,
                        backgroundColor: active ? `${color}26` : "transparent",
                      }}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                      <span className="max-w-[88px] truncate">{tag.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                if (confirmingDelete) {
                  setSettingsOpen(false);
                  void props.onDeleteList(list.id);
                } else {
                  setConfirmingDelete(true);
                }
              }}
              onBlur={() => setConfirmingDelete(false)}
              className={`h-6 px-2 rounded-md text-[11px] transition-colors cursor-pointer ${
                confirmingDelete
                  ? "bg-danger-bg text-red-500"
                  : "text-ink-ghost hover:text-red-500 hover:bg-danger-bg/70"
              }`}
            >
              {confirmingDelete
                ? t("todo.list.deleteConfirm", { defaultValue: "确认删除？" })
                : t("todo.list.delete", { defaultValue: "删除清单" })}
            </button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="px-2.5 pb-2 text-[11px] text-ink-ghost">
          {t("todo.item.empty", { defaultValue: "这个清单还没有待办" })}
        </div>
      ) : (
        <ul
          className="flex flex-col px-1 pb-1"
          onDragOver={containerDragOver}
          onDrop={(event) => {
            event.preventDefault();
            if (props.dropTarget?.listId === list.id) {
              props.onDrop(displayIds, props.dropTarget);
            } else {
              props.onDragItemChange(null);
              props.onDropTargetChange(null);
            }
          }}
        >
          {items.map((item, index) => (
            <li key={item.id}>
              {showIndicator(index) && (
                <div className="mx-2 my-0.5 h-0.5 rounded-full bg-bamboo/70" />
              )}
              <TodoItemRow
                item={item}
                tags={props.tags}
                tagsById={props.tagsById}
                editing={props.editing}
                onEditingChange={props.onEditingChange}
                onEditKeyDown={props.onEditKeyDown}
                onCommitTitle={props.onCommitTitle}
                onComplete={props.onComplete}
                onTogglePinned={props.onTogglePinned}
                onDelete={props.onDelete}
                onDueChange={props.onDueChange}
                onSetItemTags={props.onSetItemTags}
                onCreateTagAndAssign={props.onCreateTagAndAssign}
                dueEditingId={props.dueEditingId}
                onDueEditingChange={props.onDueEditingChange}
                tagEditingId={props.tagEditingId}
                onTagEditingChange={props.onTagEditingChange}
                draggable={
                  props.editing?.id !== item.id &&
                  props.dueEditingId !== item.id &&
                  props.tagEditingId !== item.id
                }
                onDragStart={(event) => {
                  props.onDragItemChange(item.id);
                  event.dataTransfer.setData("text/plain", item.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  props.onDragItemChange(null);
                  props.onDropTargetChange(null);
                }}
                onDragOver={(event) => rowDragOver(event, index)}
              />
            </li>
          ))}
          {showIndicator(items.length) && (
            <div className="mx-2 my-0.5 h-0.5 rounded-full bg-bamboo/70" />
          )}
        </ul>
      )}
      <div className="flex items-center gap-1.5 px-2 pb-2">
        <span className="text-ink-ghost text-[12px] leading-none">+</span>
        <input
          value={props.draft}
          placeholder={t("todo.item.addPlaceholder", { defaultValue: "添加待办…" })}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              props.onAdd();
            }
          }}
          className="flex-1 min-w-0 h-6 bg-transparent border-none text-[12px] text-ink placeholder:text-ink-ghost focus:outline-none"
        />
      </div>
    </section>
  );
}

interface TodoItemRowProps {
  item: TodoItem;
  tags: TodoTag[];
  tagsById: Map<string, TodoTag>;
  editing: { id: string; title: string } | null;
  onEditingChange: (editing: { id: string; title: string } | null) => void;
  onEditKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>, item: TodoItem) => void;
  onCommitTitle: (item: TodoItem) => void;
  onComplete: (item: TodoItem) => void;
  onTogglePinned: (item: TodoItem) => void;
  onDelete: (item: TodoItem) => void;
  onDueChange: (item: TodoItem, dueDate: string, time: string) => void;
  onSetItemTags: (item: TodoItem, tagIds: string[]) => void;
  onCreateTagAndAssign: (item: TodoItem, name: string) => void;
  dueEditingId: string | null;
  onDueEditingChange: (id: string | null) => void;
  tagEditingId: string | null;
  onTagEditingChange: (id: string | null) => void;
  draggable: boolean;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
}

function TodoItemRow(props: TodoItemRowProps) {
  const { t } = useTranslation();
  const { item } = props;
  const [newTagName, setNewTagName] = useState("");
  const countdown = todoCountdown(item.dueDate);
  const countdownLabel = todoCountdownLabel(countdown, t);
  const isEditing = props.editing?.id === item.id;
  const isDueEditing = props.dueEditingId === item.id;
  const isTagEditing = props.tagEditingId === item.id;

  const countdownClassName =
    countdown?.kind === "overdue"
      ? "text-red-500"
      : countdown?.kind === "today"
        ? "text-bamboo"
        : "text-ink-faint";

  const itemTagNames = item.tagIds
    .map((id) => props.tagsById.get(id)?.name ?? "")
    .filter(Boolean)
    .join("、");

  return (
    <div
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      onDoubleClick={() => !isEditing && props.onEditingChange({ id: item.id, title: item.title })}
      className="group flex items-start gap-2 px-1.5 py-1.5 rounded-lg hover:bg-paper/70 cursor-default"
    >
      <button
        type="button"
        onClick={() => props.onComplete(item)}
        className="mt-0.5 w-[15px] h-[15px] rounded-full border-[1.5px] border-ink-ghost/70 hover:border-bamboo hover:bg-bamboo-mist/60 shrink-0 transition-colors cursor-pointer"
        title={t("todo.item.complete", { defaultValue: "完成" })}
      />
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        {isEditing ? (
          <input
            autoFocus
            value={props.editing?.title ?? ""}
            onChange={(event) => props.onEditingChange({ id: item.id, title: event.target.value })}
            onKeyDown={(event) => props.onEditKeyDown(event, item)}
            onBlur={() => props.onCommitTitle(item)}
            className="w-full h-6 px-1.5 rounded-md bg-paper border border-bamboo/50 text-[12px] text-ink focus:outline-none"
          />
        ) : (
          <div className="flex items-center gap-1.5 min-w-0">
            {item.pinned && (
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="text-bamboo shrink-0"
              >
                <path d="M12 17v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            )}
            <span className="text-[12px] text-ink leading-snug break-all">{item.title}</span>
            {item.recurrence && (
              <span
                className="text-[9px] text-ink-ghost shrink-0"
                title={todoRecurrenceLabel(item.recurrence, t)}
              >
                ⟳
              </span>
            )}
            {item.tagIds.length > 0 && (
              <span className="flex items-center gap-0.5 shrink-0" title={itemTagNames}>
                {item.tagIds.slice(0, 4).map((tagId) => {
                  const tag = props.tagsById.get(tagId);
                  if (!tag) return null;
                  return (
                    <span
                      key={tagId}
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: todoTagColor(tag) }}
                    />
                  );
                })}
              </span>
            )}
            {countdownLabel && (
              <span className={`text-[10px] shrink-0 ${countdownClassName}`}>{countdownLabel}</span>
            )}
            {item.remindAt && (
              <span
                className="shrink-0 text-ink-ghost"
                title={
                  t("todo.item.remind", { defaultValue: "提醒时间（当日）" }) +
                  " " +
                  reminderTimeValue(item.remindAt)
                }
              >
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
              </span>
            )}
          </div>
        )}
        {isDueEditing && (
          <div
            className="flex items-center gap-1.5 p-1.5 rounded-md bg-paper/80 border border-paper-deep/40"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                props.onDueEditingChange(null);
              }
            }}
          >
            <input
              autoFocus
              type="date"
              value={item.dueDate ?? ""}
              onChange={(event) =>
                props.onDueChange(item, event.target.value, reminderTimeValue(item.remindAt))
              }
              className="w-[124px] h-6 px-1 rounded-md bg-paper border border-paper-deep/40 text-[11px] text-ink focus:outline-none focus:border-bamboo/60"
            />
            <input
              type="time"
              disabled={!item.dueDate}
              value={reminderTimeValue(item.remindAt)}
              title={t("todo.item.remind", { defaultValue: "提醒时间（当日）" })}
              onChange={(event) =>
                item.dueDate ? props.onDueChange(item, item.dueDate, event.target.value) : undefined
              }
              className="w-[92px] h-6 px-1 rounded-md bg-paper border border-paper-deep/40 text-[11px] text-ink disabled:opacity-40 focus:outline-none focus:border-bamboo/60"
            />
            <button
              type="button"
              onClick={() => props.onDueEditingChange(null)}
              className="w-5 h-5 flex items-center justify-center rounded text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/60 transition-colors cursor-pointer"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        {isTagEditing && (
          <div className="flex flex-col gap-1.5 p-1.5 rounded-md bg-paper/80 border border-paper-deep/40">
            {props.tags.length === 0 ? (
              <div className="text-[11px] text-ink-ghost">
                {t("todo.tags.empty", { defaultValue: "还没有标签" })}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {props.tags.map((tag) => {
                  const active = item.tagIds.includes(tag.id);
                  const color = todoTagColor(tag);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => props.onSetItemTags(item, toggleTagId(item.tagIds, tag.id))}
                      className={`flex items-center gap-1 h-6 px-2 rounded-full border text-[11px] transition-colors cursor-pointer ${
                        active ? "text-ink" : "text-ink-faint hover:text-ink"
                      }`}
                      style={{
                        borderColor: color,
                        backgroundColor: active ? `${color}26` : "transparent",
                      }}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                      <span className="max-w-[88px] truncate">{tag.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-1">
              <input
                value={newTagName}
                placeholder={t("todo.tags.newPlaceholder", { defaultValue: "新标签名" })}
                onChange={(event) => setNewTagName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    props.onCreateTagAndAssign(item, newTagName);
                    setNewTagName("");
                  }
                }}
                className="flex-1 min-w-0 h-6 px-1.5 rounded-md bg-paper border border-paper-deep/40 text-[11px] text-ink placeholder:text-ink-ghost focus:outline-none focus:border-bamboo/60"
              />
              <button
                type="button"
                disabled={!newTagName.trim()}
                onClick={() => {
                  props.onCreateTagAndAssign(item, newTagName);
                  setNewTagName("");
                }}
                className="h-6 px-2 rounded-md bg-bamboo/90 text-white text-[11px] disabled:opacity-40 hover:bg-bamboo transition-colors cursor-pointer"
              >
                {t("todo.tags.create", { defaultValue: "新建" })}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <RowIconButton
          title={t("todo.item.tags", { defaultValue: "标签" })}
          onClick={() => props.onTagEditingChange(isTagEditing ? null : item.id)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
            <circle cx="7.5" cy="7.5" r="0.5" fill="currentColor" />
          </svg>
        </RowIconButton>
        <RowIconButton
          title={t("todo.item.due", { defaultValue: "设置目标日" })}
          onClick={() => props.onDueEditingChange(isDueEditing ? null : item.id)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        </RowIconButton>
        <RowIconButton
          title={
            item.pinned
              ? t("todo.item.unpin", { defaultValue: "取消置顶" })
              : t("todo.item.pin", { defaultValue: "置顶" })
          }
          onClick={() => props.onTogglePinned(item)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 17v5" />
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
          </svg>
        </RowIconButton>
        <RowIconButton
          title={t("todo.item.delete", { defaultValue: "删除" })}
          onClick={() => props.onDelete(item)}
          danger
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 6h18" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </RowIconButton>
      </div>
    </div>
  );
}

function TagManagerDialog({
  tags,
  onClose,
  onCreateTag,
  onUpdateTag,
  onDeleteTag,
}: {
  tags: TodoTag[];
  onClose: () => void;
  onCreateTag: (name: string, color: string) => Promise<void>;
  onUpdateTag: (id: string, name: string, color: string) => Promise<void>;
  onDeleteTag: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState<string>(TODO_TAG_PALETTE[0]);
  const [editingTag, setEditingTag] = useState<{ id: string; name: string; color: string } | null>(
    null,
  );
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const handleCreate = async () => {
    const name = newTagName.trim();
    if (!name) return;
    try {
      await onCreateTag(name, newTagColor);
      setNewTagName("");
    } catch (error) {
      showToast(getTodoErrorMessage(error), "error");
    }
  };

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-ink/20 backdrop-blur-[1px] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[280px] max-h-full rounded-xl bg-paper border border-paper-deep/50 shadow-lg flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-3 h-9 border-b border-paper-deep/30 shrink-0">
          <span className="text-[12px] font-medium text-ink-soft">
            {t("todo.tags.manage", { defaultValue: "管理标签" })}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-ink-ghost hover:text-red-400 hover:bg-danger-bg/70 transition-colors cursor-pointer"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2.5 flex flex-col gap-1.5">
          {tags.length === 0 && (
            <div className="text-[11px] text-ink-ghost text-center py-2">
              {t("todo.tags.empty", { defaultValue: "还没有标签" })}
            </div>
          )}
          {tags.map((tag) =>
            editingTag?.id === tag.id ? (
              <div
                key={tag.id}
                className="p-2 rounded-lg bg-cloud/70 border border-bamboo/40 flex flex-col gap-2"
              >
                <input
                  autoFocus
                  value={editingTag.name}
                  onChange={(event) => setEditingTag({ ...editingTag, name: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const name = editingTag.name.trim();
                      if (name) {
                        void onUpdateTag(tag.id, name, editingTag.color)
                          .then(() => setEditingTag(null))
                          .catch((error) => showToast(getTodoErrorMessage(error), "error"));
                      }
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingTag(null);
                    }
                  }}
                  className="w-full h-6 px-1.5 rounded-md bg-paper border border-paper-deep/40 text-[12px] text-ink focus:outline-none focus:border-bamboo/60"
                />
                <PalettePicker
                  value={editingTag.color}
                  onChange={(color) => setEditingTag({ ...editingTag, color })}
                />
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEditingTag(null)}
                    className="h-6 px-2 rounded-md text-[11px] text-ink-faint hover:text-ink cursor-pointer"
                  >
                    {t("common.cancel", { defaultValue: "取消" })}
                  </button>
                  <button
                    type="button"
                    disabled={!editingTag.name.trim()}
                    onClick={() => {
                      const name = editingTag.name.trim();
                      if (!name) return;
                      void onUpdateTag(tag.id, name, editingTag.color)
                        .then(() => setEditingTag(null))
                        .catch((error) => showToast(getTodoErrorMessage(error), "error"));
                    }}
                    className="h-6 px-2.5 rounded-md bg-bamboo/90 text-white text-[11px] disabled:opacity-40 hover:bg-bamboo transition-colors cursor-pointer"
                  >
                    {t("common.save", { defaultValue: "保存" })}
                  </button>
                </div>
              </div>
            ) : (
              <div
                key={tag.id}
                className="group flex items-center gap-2 px-1.5 h-8 rounded-lg hover:bg-cloud/70"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: todoTagColor(tag) }}
                />
                <span className="flex-1 min-w-0 text-[12px] text-ink truncate">{tag.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setEditingTag({
                      id: tag.id,
                      name: tag.name,
                      color: tag.color || todoTagColor(tag),
                    })
                  }
                  className="w-5 h-5 flex items-center justify-center rounded text-ink-ghost opacity-0 group-hover:opacity-100 hover:text-bamboo hover:bg-bamboo-mist/60 transition-all cursor-pointer"
                  title={t("common.edit", { defaultValue: "编辑" })}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirmingDeleteId === tag.id) {
                      setConfirmingDeleteId(null);
                      void onDeleteTag(tag.id).catch((error) =>
                        showToast(getTodoErrorMessage(error), "error"),
                      );
                    } else {
                      setConfirmingDeleteId(tag.id);
                    }
                  }}
                  onBlur={() => setConfirmingDeleteId(null)}
                  className={`h-5 px-1.5 flex items-center justify-center rounded text-[10px] transition-all cursor-pointer ${
                    confirmingDeleteId === tag.id
                      ? "text-red-500 bg-danger-bg opacity-100"
                      : "text-ink-ghost opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-danger-bg/70"
                  }`}
                  title={t("todo.tags.delete", { defaultValue: "删除标签" })}
                >
                  {confirmingDeleteId === tag.id
                    ? t("todo.tags.deleteConfirm", { defaultValue: "确认？" })
                    : ""}
                  {confirmingDeleteId !== tag.id && (
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 6h18" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  )}
                </button>
              </div>
            ),
          )}
        </div>
        <div className="p-2.5 border-t border-paper-deep/30 shrink-0 flex flex-col gap-2">
          <input
            value={newTagName}
            placeholder={t("todo.tags.newPlaceholder", { defaultValue: "新标签名" })}
            onChange={(event) => setNewTagName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleCreate();
              }
            }}
            className="w-full h-7 px-2 rounded-md bg-cloud/70 border border-paper-deep/40 text-[12px] text-ink placeholder:text-ink-ghost focus:outline-none focus:border-bamboo/60"
          />
          <PalettePicker value={newTagColor} onChange={setNewTagColor} />
          <button
            type="button"
            disabled={!newTagName.trim()}
            onClick={() => void handleCreate()}
            className="w-full h-7 rounded-md bg-bamboo/90 text-white text-[12px] disabled:opacity-40 hover:bg-bamboo transition-colors cursor-pointer"
          >
            {t("todo.tags.create", { defaultValue: "新建" })}
          </button>
        </div>
      </div>
    </div>
  );
}

function PalettePicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {TODO_TAG_PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          className={`w-4 h-4 rounded-full transition-transform cursor-pointer ${
            value === color ? "ring-2 ring-bamboo ring-offset-1 ring-offset-paper" : ""
          }`}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}

function RowIconButton({
  title,
  onClick,
  danger = false,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`w-5 h-5 flex items-center justify-center rounded transition-colors cursor-pointer ${
        danger
          ? "text-ink-ghost hover:text-red-500 hover:bg-danger-bg/70"
          : "text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/60"
      }`}
    >
      {children}
    </button>
  );
}
