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
  deleteTodoItem,
  getTodoErrorMessage,
  listTodoItems,
  listTodoLists,
  reorderTodoItems,
  setTodoItemPinned,
  spawnTodoDue,
  updateTodoItem,
} from "../features/todos/api";
import type { TodoItem, TodoList } from "../features/todos/types";
import {
  groupTodoItems,
  reorderIdsAfterDrop,
  saveRequestFromItem,
  todoCountdown,
  todoCountdownLabel,
  todoRecurrenceLabel,
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [creatingList, setCreatingList] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [dueEditingId, setDueEditingId] = useState<string | null>(null);
  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const epochRef = useRef(0);

  const refresh = useCallback(() => {
    const epoch = ++epochRef.current;
    Promise.all([listTodoLists(), listTodoItems()])
      .then(([nextLists, nextItems]) => {
        if (epochRef.current !== epoch) return;
        setLists(nextLists);
        setItems(nextItems);
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

  const groups = useMemo(() => groupTodoItems(items, lists), [items, lists]);

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

  const handleDueChange = async (item: TodoItem, value: string) => {
    setDueEditingId(null);
    const dueDate = value || null;
    if (dueDate === (item.dueDate ?? null)) return;
    try {
      await updateTodoItem(item.id, saveRequestFromItem(item, { dueDate }));
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

        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
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
                {t("todo.empty.title", { defaultValue: "还没有清单" })}
                <div className="mt-0.5 text-[11px] text-ink-ghost">
                  {t("todo.empty.hint", { defaultValue: "创建第一个清单，开始整理待办" })}
                </div>
              </div>
              <NewListForm
                value={newListName}
                onChange={setNewListName}
                onSubmit={handleCreateList}
                submitting={creatingList}
                autoFocus
              />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((group) => (
                <TodoListSection
                  key={group.list.id}
                  list={group.list}
                  items={group.items}
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
                  onDueChange={(item, value) => void handleDueChange(item, value)}
                  dueEditingId={dueEditingId}
                  onDueEditingChange={setDueEditingId}
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

interface TodoListSectionProps {
  list: TodoList;
  items: TodoItem[];
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
  onDueChange: (item: TodoItem, value: string) => void;
  dueEditingId: string | null;
  onDueEditingChange: (id: string | null) => void;
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
    // 仅当悬停在行之间的空白（容器本身）时落到末尾
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    props.onDropTargetChange({ listId: list.id, index: items.length });
  };

  const showIndicator = (index: number) =>
    props.dropTarget?.listId === list.id && props.dropTarget.index === index && props.dragItemId;

  return (
    <section className="rounded-xl bg-paper/40 border border-paper-deep/30 overflow-hidden">
      <header className="flex items-center justify-between px-2.5 pt-2 pb-1">
        <span className="text-[12px] font-medium text-ink-soft truncate">{list.name}</span>
        <span className="text-[10px] text-ink-ghost shrink-0">{items.length}</span>
      </header>
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
                editing={props.editing}
                onEditingChange={props.onEditingChange}
                onEditKeyDown={props.onEditKeyDown}
                onCommitTitle={props.onCommitTitle}
                onComplete={props.onComplete}
                onTogglePinned={props.onTogglePinned}
                onDelete={props.onDelete}
                onDueChange={props.onDueChange}
                dueEditingId={props.dueEditingId}
                onDueEditingChange={props.onDueEditingChange}
                draggable={props.editing?.id !== item.id && props.dueEditingId !== item.id}
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
  editing: { id: string; title: string } | null;
  onEditingChange: (editing: { id: string; title: string } | null) => void;
  onEditKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>, item: TodoItem) => void;
  onCommitTitle: (item: TodoItem) => void;
  onComplete: (item: TodoItem) => void;
  onTogglePinned: (item: TodoItem) => void;
  onDelete: (item: TodoItem) => void;
  onDueChange: (item: TodoItem, value: string) => void;
  dueEditingId: string | null;
  onDueEditingChange: (id: string | null) => void;
  draggable: boolean;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
}

function TodoItemRow(props: TodoItemRowProps) {
  const { t } = useTranslation();
  const { item } = props;
  const countdown = todoCountdown(item.dueDate);
  const countdownLabel = todoCountdownLabel(countdown, t);
  const isEditing = props.editing?.id === item.id;
  const isDueEditing = props.dueEditingId === item.id;

  const countdownClassName =
    countdown?.kind === "overdue"
      ? "text-red-500"
      : countdown?.kind === "today"
        ? "text-bamboo"
        : "text-ink-faint";

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
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
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
            {countdownLabel && (
              <span className={`text-[10px] shrink-0 ${countdownClassName}`}>{countdownLabel}</span>
            )}
          </div>
        )}
        {isDueEditing && (
          <input
            autoFocus
            type="date"
            value={item.dueDate ?? ""}
            onChange={(event) => props.onDueChange(item, event.target.value)}
            onBlur={() => props.onDueEditingChange(null)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                props.onDueEditingChange(null);
              }
            }}
            className="w-[132px] h-6 px-1 rounded-md bg-paper border border-bamboo/50 text-[11px] text-ink focus:outline-none"
          />
        )}
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
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
