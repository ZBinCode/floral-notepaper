use super::notes::{default_store as default_note_store, AppError};
use crate::json_io::write_json_atomic;
use chrono::{DateTime, Datelike, Duration as ChronoDuration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

fn todo_error(code: &str, message: String, id_detail: Option<(&str, &str)>) -> AppError {
    let mut details = BTreeMap::new();
    if let Some((key, value)) = id_detail {
        details.insert(key.to_string(), value.to_string());
    }
    AppError {
        code: code.to_string(),
        message,
        details,
    }
}

// ---------------------------------------------------------------------------
// 重复规则
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TodoRecurrenceFreq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// by_weekdays 用 0=周一 .. 6=周日（ISO 顺序），仅 weekly 频率有意义；
/// anchor_date 视为第 0 次出现，之后按 freq × interval 推进
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoRecurrenceRule {
    pub freq: TodoRecurrenceFreq,
    #[serde(default = "default_recurrence_interval")]
    pub interval: u32,
    #[serde(default)]
    pub by_weekdays: Vec<u8>,
    pub anchor_date: NaiveDate,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_date: Option<NaiveDate>,
}

fn default_recurrence_interval() -> u32 {
    1
}

impl TodoRecurrenceRule {
    fn normalized(&self) -> Result<Self, AppError> {
        if self.end_date.is_some_and(|end| end < self.anchor_date) {
            return Err(todo_error(
                "todoRecurrenceInvalid",
                "重复规则的结束日期不能早于起始日期".into(),
                None,
            ));
        }
        let mut by_weekdays: Vec<u8> = self
            .by_weekdays
            .iter()
            .copied()
            .filter(|day| *day <= 6)
            .collect();
        by_weekdays.sort_unstable();
        by_weekdays.dedup();
        Ok(Self {
            freq: self.freq,
            interval: self.interval.max(1),
            by_weekdays,
            anchor_date: self.anchor_date,
            end_date: self.end_date,
        })
    }
}

/// 严格晚于 `from` 的下一次出现日期；超过 end_date（周期结束）返回 None
fn advance_occurrence(from: NaiveDate, rule: &TodoRecurrenceRule) -> Option<NaiveDate> {
    let interval = rule.interval.max(1) as i64;
    let candidate = match rule.freq {
        TodoRecurrenceFreq::Daily => from.checked_add_signed(ChronoDuration::days(interval))?,
        TodoRecurrenceFreq::Weekly => {
            if rule.by_weekdays.is_empty() {
                from.checked_add_signed(ChronoDuration::weeks(interval))?
            } else {
                next_by_weekday(from, &rule.by_weekdays, interval, rule.anchor_date)?
            }
        }
        TodoRecurrenceFreq::Monthly => add_months_clamped(from, rule.interval.max(1))?,
        TodoRecurrenceFreq::Yearly => add_months_clamped(from, rule.interval.max(1) * 12)?,
    };
    match rule.end_date {
        Some(end) if candidate > end => None,
        _ => Some(candidate),
    }
}

/// weekly + byWeekdays：从 from+1 逐日找下一个命中星期几、且与锚定周相差
/// 整数个 interval 周的日期。步数上界保证有界循环（interval 周内必含一个命中日）
fn next_by_weekday(
    from: NaiveDate,
    weekdays: &[u8],
    interval: i64,
    anchor: NaiveDate,
) -> Option<NaiveDate> {
    let max_steps = 7 * interval + 14;
    let mut candidate = from.checked_add_signed(ChronoDuration::days(1))?;
    for _ in 0..max_steps {
        let weekday = candidate.weekday().num_days_from_monday() as u8;
        if weekdays.contains(&weekday) && week_steps_between(anchor, candidate) % interval == 0 {
            return Some(candidate);
        }
        candidate = candidate.checked_add_signed(ChronoDuration::days(1))?;
    }
    None
}

fn monday_of(date: NaiveDate) -> NaiveDate {
    date - ChronoDuration::days(i64::from(date.weekday().num_days_from_monday()))
}

fn week_steps_between(anchor: NaiveDate, candidate: NaiveDate) -> i64 {
    (monday_of(candidate) - monday_of(anchor)).num_weeks()
}

/// 按月推进并钳制到目标月最后一天（如 1/31 → 2/28）。
/// 已知简化：钳制后以钳制日为新基准继续推进（2/28 → 3/28），不记忆原始 31 日
fn add_months_clamped(from: NaiveDate, months: u32) -> Option<NaiveDate> {
    let total = from.year() * 12 + from.month0() as i32 + months as i32;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) + 1;
    let next_month_first = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(year, month as u32 + 1, 1)?
    };
    let last_day = next_month_first.pred_opt()?.day();
    NaiveDate::from_ymd_opt(year, month as u32, from.day().min(last_day))
}

fn shift_reminder(remind_at: Option<DateTime<Utc>>, days: i64) -> Option<DateTime<Utc>> {
    remind_at.and_then(|at| at.checked_add_signed(ChronoDuration::days(days)))
}

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoList {
    pub id: String,
    pub name: String,
    pub sort_order: i32,
    /// 在该清单下新建待办时自动附加的标签（“在清单上添加待办时自动贴标签”）
    #[serde(default)]
    pub default_tag_ids: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoTag {
    pub id: String,
    pub name: String,
    /// 颜色由前端调色板生成（hex 字符串），此处不做格式约束
    #[serde(default)]
    pub color: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    pub list_id: String,
    pub title: String,
    /// 置顶项在清单内排在最前
    #[serde(default)]
    pub pinned: bool,
    pub sort_order: i32,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    /// 目标日，前端据此渲染日期倒数
    #[serde(default)]
    pub due_date: Option<NaiveDate>,
    #[serde(default)]
    pub remind_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<TodoRecurrenceRule>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 活跃待办没有 done 字段：完成即按完成时间归档（completed_at 是分组键），
/// 撤销完成通过 restore 把归档条目放回活跃集合
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoArchiveEntry {
    pub id: String,
    pub list_id: String,
    /// 完成时的清单名快照：清单随后被删除也不影响回顾展示
    pub list_name: String,
    pub title: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub due_date: Option<NaiveDate>,
    #[serde(default)]
    pub remind_at: Option<DateTime<Utc>>,
    pub completed_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTodoItemRequest {
    pub list_id: String,
    pub title: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub due_date: Option<NaiveDate>,
    #[serde(default)]
    pub remind_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub recurrence: Option<TodoRecurrenceRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoListRequest {
    pub name: String,
    #[serde(default)]
    pub default_tag_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoTagRequest {
    pub name: String,
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoTagRequest {
    pub name: String,
    #[serde(default)]
    pub color: String,
}

/// 完成重复待办时的结果：archived 是归档快照；
/// next_item 为推进到下一期的模板（周期已结束时为 None）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoCompleteResult {
    pub archived: TodoArchiveEntry,
    pub next_item: Option<TodoItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TodoStoreFile {
    #[serde(default)]
    lists: Vec<TodoList>,
    #[serde(default)]
    tags: Vec<TodoTag>,
    #[serde(default)]
    items: Vec<TodoItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TodoArchiveFile {
    #[serde(default)]
    entries: Vec<TodoArchiveEntry>,
}

// ---------------------------------------------------------------------------
// 存储与命令逻辑
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TodoStore {
    data_dir: PathBuf,
}

pub fn default_store() -> Result<TodoStore, AppError> {
    let data_dir = default_note_store()?.data_dir().to_path_buf();
    Ok(TodoStore { data_dir })
}

impl TodoStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn todos_path(&self) -> PathBuf {
        self.data_dir.join("todos.json")
    }

    fn archive_path(&self) -> PathBuf {
        self.data_dir.join("todo-archive.json")
    }

    fn load_store_file(&self) -> Result<TodoStoreFile, AppError> {
        fs::create_dir_all(&self.data_dir)?;
        let path = self.todos_path();
        if !path.exists() {
            let empty = TodoStoreFile::default();
            write_json_atomic(&path, &empty)?;
            return Ok(empty);
        }
        match serde_json::from_str(&fs::read_to_string(&path)?) {
            Ok(file) => Ok(file),
            Err(_) => {
                // 待办没有文件系统真值可重建（不同于笔记的 .md），损坏时
                // 备份原件供取证，然后从空集合重新开始
                back_up_corrupt(&path);
                let empty = TodoStoreFile::default();
                write_json_atomic(&path, &empty)?;
                Ok(empty)
            }
        }
    }

    fn save_store_file(&self, file: &TodoStoreFile) -> Result<(), AppError> {
        fs::create_dir_all(&self.data_dir)?;
        write_json_atomic(&self.todos_path(), file)
    }

    fn load_archive_file(&self) -> Result<TodoArchiveFile, AppError> {
        fs::create_dir_all(&self.data_dir)?;
        let path = self.archive_path();
        if !path.exists() {
            return Ok(TodoArchiveFile::default());
        }
        match serde_json::from_str(&fs::read_to_string(&path)?) {
            Ok(file) => Ok(file),
            Err(_) => {
                back_up_corrupt(&path);
                Ok(TodoArchiveFile::default())
            }
        }
    }

    fn save_archive_file(&self, file: &TodoArchiveFile) -> Result<(), AppError> {
        fs::create_dir_all(&self.data_dir)?;
        write_json_atomic(&self.archive_path(), file)
    }

    // ----- 清单 -----

    pub fn list_lists(&self) -> Result<Vec<TodoList>, AppError> {
        let mut lists = self.load_store_file()?.lists;
        lists.sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then_with(|| a.created_at.cmp(&b.created_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(lists)
    }

    pub fn create_list(
        &self,
        request: CreateTodoListRequest,
        now: DateTime<Utc>,
    ) -> Result<TodoList, AppError> {
        let name = request.name.trim().to_string();
        if name.is_empty() {
            return Err(todo_error(
                "todoListNameEmpty",
                "清单名不能为空".into(),
                None,
            ));
        }
        let mut file = self.load_store_file()?;
        if file.lists.iter().any(|list| list.name == name) {
            return Err(todo_error(
                "todoListNameExists",
                format!("清单「{name}」已存在"),
                Some(("name", name.as_str())),
            ));
        }
        let default_tag_ids = self.existing_tag_ids(&file, &request.default_tag_ids)?;
        let list = TodoList {
            id: Uuid::new_v4().to_string(),
            name,
            sort_order: file
                .lists
                .iter()
                .map(|list| list.sort_order)
                .max()
                .unwrap_or(-1)
                + 1,
            default_tag_ids,
            created_at: now,
            updated_at: now,
        };
        file.lists.push(list.clone());
        self.save_store_file(&file)?;
        Ok(list)
    }

    pub fn rename_list(
        &self,
        id: &str,
        name: &str,
        now: DateTime<Utc>,
    ) -> Result<TodoList, AppError> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(todo_error(
                "todoListNameEmpty",
                "清单名不能为空".into(),
                None,
            ));
        }
        let mut file = self.load_store_file()?;
        if file
            .lists
            .iter()
            .any(|list| list.id != id && list.name == name)
        {
            return Err(todo_error(
                "todoListNameExists",
                format!("清单「{name}」已存在"),
                Some(("name", name.as_str())),
            ));
        }
        let list = file
            .lists
            .iter_mut()
            .find(|list| list.id == id)
            .ok_or_else(|| {
                todo_error(
                    "todoListNotFound",
                    format!("清单 {id} 不存在"),
                    Some(("listId", id)),
                )
            })?;
        list.name = name;
        list.updated_at = now;
        let updated = list.clone();
        self.save_store_file(&file)?;
        Ok(updated)
    }

    /// 配置清单的默认标签（新建待办时自动附加）；未知标签 id 直接报错
    pub fn set_list_default_tags(
        &self,
        id: &str,
        tag_ids: &[String],
        now: DateTime<Utc>,
    ) -> Result<TodoList, AppError> {
        let mut file = self.load_store_file()?;
        let default_tag_ids = self.existing_tag_ids(&file, tag_ids)?;
        let list = file
            .lists
            .iter_mut()
            .find(|list| list.id == id)
            .ok_or_else(|| {
                todo_error(
                    "todoListNotFound",
                    format!("清单 {id} 不存在"),
                    Some(("listId", id)),
                )
            })?;
        list.default_tag_ids = default_tag_ids;
        list.updated_at = now;
        let updated = list.clone();
        self.save_store_file(&file)?;
        Ok(updated)
    }

    /// 级联删除清单下的活跃待办；归档条目保留（历史回顾不受清单删除影响）
    pub fn delete_list(&self, id: &str) -> Result<(), AppError> {
        let mut file = self.load_store_file()?;
        let before = file.lists.len();
        file.lists.retain(|list| list.id != id);
        if file.lists.len() == before {
            return Err(todo_error(
                "todoListNotFound",
                format!("清单 {id} 不存在"),
                Some(("listId", id)),
            ));
        }
        file.items.retain(|item| item.list_id != id);
        self.save_store_file(&file)
    }

    /// 宽松重排：按传入顺序赋序，未提及的清单排在提及者之后（保持现有相对顺序）。
    /// 跨窗口并发下前端列表可能滞后，硬报错反而破坏拖拽体验
    pub fn reorder_lists(
        &self,
        ordered_ids: &[String],
        now: DateTime<Utc>,
    ) -> Result<Vec<TodoList>, AppError> {
        let mut file = self.load_store_file()?;
        let mut orders: Vec<(String, i32)> = file
            .lists
            .iter()
            .map(|list| (list.id.clone(), list.sort_order))
            .collect();
        apply_reorder(&mut orders, ordered_ids);
        for (id, order) in &orders {
            if let Some(list) = file.lists.iter_mut().find(|list| &list.id == id) {
                if list.sort_order != *order {
                    list.sort_order = *order;
                    list.updated_at = now;
                }
            }
        }
        self.save_store_file(&file)?;
        self.list_lists()
    }

    // ----- 标签 -----

    pub fn list_tags(&self) -> Result<Vec<TodoTag>, AppError> {
        Ok(self.load_store_file()?.tags)
    }

    pub fn create_tag(
        &self,
        request: CreateTodoTagRequest,
        now: DateTime<Utc>,
    ) -> Result<TodoTag, AppError> {
        let name = request.name.trim().to_string();
        if name.is_empty() {
            return Err(todo_error(
                "todoTagNameEmpty",
                "标签名不能为空".into(),
                None,
            ));
        }
        let mut file = self.load_store_file()?;
        if file.tags.iter().any(|tag| tag.name == name) {
            return Err(todo_error(
                "todoTagNameExists",
                format!("标签「{name}」已存在"),
                Some(("name", name.as_str())),
            ));
        }
        let tag = TodoTag {
            id: Uuid::new_v4().to_string(),
            name,
            color: request.color.trim().to_string(),
            created_at: now,
            updated_at: now,
        };
        file.tags.push(tag.clone());
        self.save_store_file(&file)?;
        Ok(tag)
    }

    pub fn update_tag(
        &self,
        id: &str,
        request: UpdateTodoTagRequest,
        now: DateTime<Utc>,
    ) -> Result<TodoTag, AppError> {
        let name = request.name.trim().to_string();
        if name.is_empty() {
            return Err(todo_error(
                "todoTagNameEmpty",
                "标签名不能为空".into(),
                None,
            ));
        }
        let mut file = self.load_store_file()?;
        if file.tags.iter().any(|tag| tag.id != id && tag.name == name) {
            return Err(todo_error(
                "todoTagNameExists",
                format!("标签「{name}」已存在"),
                Some(("name", name.as_str())),
            ));
        }
        let tag = file
            .tags
            .iter_mut()
            .find(|tag| tag.id == id)
            .ok_or_else(|| {
                todo_error(
                    "todoTagNotFound",
                    format!("标签 {id} 不存在"),
                    Some(("tagId", id)),
                )
            })?;
        tag.name = name;
        tag.color = request.color.trim().to_string();
        tag.updated_at = now;
        let updated = tag.clone();
        self.save_store_file(&file)?;
        Ok(updated)
    }

    /// 删除标签时同步剥离清单默认标签与待办标签上的引用
    pub fn delete_tag(&self, id: &str) -> Result<(), AppError> {
        let mut file = self.load_store_file()?;
        let before = file.tags.len();
        file.tags.retain(|tag| tag.id != id);
        if file.tags.len() == before {
            return Err(todo_error(
                "todoTagNotFound",
                format!("标签 {id} 不存在"),
                Some(("tagId", id)),
            ));
        }
        for list in &mut file.lists {
            list.default_tag_ids.retain(|tag_id| tag_id != id);
        }
        for item in &mut file.items {
            item.tag_ids.retain(|tag_id| tag_id != id);
        }
        self.save_store_file(&file)
    }

    fn existing_tag_ids(
        &self,
        file: &TodoStoreFile,
        ids: &[String],
    ) -> Result<Vec<String>, AppError> {
        let mut result: Vec<String> = Vec::new();
        for id in ids {
            if !file.tags.iter().any(|tag| &tag.id == id) {
                return Err(todo_error(
                    "todoTagNotFound",
                    format!("标签 {id} 不存在"),
                    Some(("tagId", id)),
                ));
            }
            if !result.contains(id) {
                result.push(id.clone());
            }
        }
        Ok(result)
    }

    // ----- 待办 -----

    pub fn list_items(&self, list_id: Option<&str>) -> Result<Vec<TodoItem>, AppError> {
        let mut items = self.load_store_file()?.items;
        if let Some(list_id) = list_id {
            items.retain(|item| item.list_id == list_id);
        }
        items.sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then_with(|| a.created_at.cmp(&b.created_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(items)
    }

    pub fn create_item(
        &self,
        request: SaveTodoItemRequest,
        now: DateTime<Utc>,
    ) -> Result<TodoItem, AppError> {
        let title = request.title.trim().to_string();
        if title.is_empty() {
            return Err(todo_error(
                "todoTitleEmpty",
                "待办标题不能为空".into(),
                None,
            ));
        }
        let recurrence = request
            .recurrence
            .map(|rule| rule.normalized())
            .transpose()?;
        let mut file = self.load_store_file()?;
        let Some(list) = file.lists.iter().find(|list| list.id == request.list_id) else {
            return Err(todo_error(
                "todoListNotFound",
                format!("清单 {} 不存在", request.list_id),
                Some(("listId", request.list_id.as_str())),
            ));
        };
        // 手工传入的标签在前，清单默认标签去重补在后
        let mut tag_ids = self.existing_tag_ids(&file, &request.tag_ids)?;
        for tag_id in &list.default_tag_ids {
            if !tag_ids.contains(tag_id) && file.tags.iter().any(|tag| &tag.id == tag_id) {
                tag_ids.push(tag_id.clone());
            }
        }
        let sort_order = next_sort_order(&file.items, &request.list_id);
        let item = TodoItem {
            id: Uuid::new_v4().to_string(),
            list_id: request.list_id,
            title,
            pinned: request.pinned,
            sort_order,
            tag_ids,
            due_date: resolve_due_date(request.due_date, &recurrence, now),
            remind_at: request.remind_at,
            recurrence,
            created_at: now,
            updated_at: now,
        };
        file.items.push(item.clone());
        self.save_store_file(&file)?;
        Ok(item)
    }

    pub fn update_item(
        &self,
        id: &str,
        request: SaveTodoItemRequest,
        now: DateTime<Utc>,
    ) -> Result<TodoItem, AppError> {
        let title = request.title.trim().to_string();
        if title.is_empty() {
            return Err(todo_error(
                "todoTitleEmpty",
                "待办标题不能为空".into(),
                None,
            ));
        }
        let recurrence = request
            .recurrence
            .map(|rule| rule.normalized())
            .transpose()?;
        let mut file = self.load_store_file()?;
        if !file.lists.iter().any(|list| list.id == request.list_id) {
            return Err(todo_error(
                "todoListNotFound",
                format!("清单 {} 不存在", request.list_id),
                Some(("listId", request.list_id.as_str())),
            ));
        }
        // 只读阶段先算好全部新值，避免与下面的可变借用交叉
        let mut tag_ids = self.existing_tag_ids(&file, &request.tag_ids)?;
        for tag_id in file
            .lists
            .iter()
            .find(|list| list.id == request.list_id)
            .map(|list| list.default_tag_ids.clone())
            .unwrap_or_default()
        {
            if !tag_ids.contains(&tag_id) && file.tags.iter().any(|tag| tag.id == tag_id) {
                tag_ids.push(tag_id);
            }
        }
        let due_date = resolve_due_date(request.due_date, &recurrence, now);
        let moving_list = file
            .items
            .iter()
            .find(|item| item.id == id)
            .is_some_and(|item| item.list_id != request.list_id);
        let target_sort_order = moving_list.then(|| next_sort_order(&file.items, &request.list_id));

        let item = file
            .items
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| {
                todo_error(
                    "todoItemNotFound",
                    format!("待办 {id} 不存在"),
                    Some(("itemId", id)),
                )
            })?;
        // 允许通过 update 换清单；换清单时排到目标清单末尾
        if let Some(order) = target_sort_order {
            item.sort_order = order;
        }
        item.list_id = request.list_id;
        item.title = title;
        item.pinned = request.pinned;
        item.tag_ids = tag_ids;
        item.due_date = due_date;
        item.remind_at = request.remind_at;
        item.recurrence = recurrence;
        item.updated_at = now;
        let updated = item.clone();
        self.save_store_file(&file)?;
        Ok(updated)
    }

    pub fn delete_item(&self, id: &str) -> Result<(), AppError> {
        let mut file = self.load_store_file()?;
        let before = file.items.len();
        file.items.retain(|item| item.id != id);
        if file.items.len() == before {
            return Err(todo_error(
                "todoItemNotFound",
                format!("待办 {id} 不存在"),
                Some(("itemId", id)),
            ));
        }
        self.save_store_file(&file)
    }

    pub fn set_item_pinned(
        &self,
        id: &str,
        pinned: bool,
        now: DateTime<Utc>,
    ) -> Result<TodoItem, AppError> {
        let mut file = self.load_store_file()?;
        let item = file
            .items
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| {
                todo_error(
                    "todoItemNotFound",
                    format!("待办 {id} 不存在"),
                    Some(("itemId", id)),
                )
            })?;
        item.pinned = pinned;
        item.updated_at = now;
        let updated = item.clone();
        self.save_store_file(&file)?;
        Ok(updated)
    }

    /// 宽松重排，语义同 reorder_lists（仅作用于指定清单内的待办）
    pub fn reorder_items(
        &self,
        list_id: &str,
        ordered_ids: &[String],
        now: DateTime<Utc>,
    ) -> Result<Vec<TodoItem>, AppError> {
        let mut file = self.load_store_file()?;
        if !file.lists.iter().any(|list| list.id == list_id) {
            return Err(todo_error(
                "todoListNotFound",
                format!("清单 {list_id} 不存在"),
                Some(("listId", list_id)),
            ));
        }
        let mut scoped: Vec<(String, i32)> = file
            .items
            .iter()
            .filter(|item| item.list_id == list_id)
            .map(|item| (item.id.clone(), item.sort_order))
            .collect();
        apply_reorder(&mut scoped, ordered_ids);
        for (id, order) in &scoped {
            if let Some(item) = file.items.iter_mut().find(|item| &item.id == id) {
                if item.sort_order != *order {
                    item.sort_order = *order;
                    item.updated_at = now;
                }
            }
        }
        self.save_store_file(&file)?;
        self.list_items(Some(list_id))
    }

    /// 完成待办：写入归档（completed_at 为分组键）；重复待办完成的是“当前这一期”，
    /// 模板推进到严格晚于今天的下一期并留在活跃集合，周期结束时模板一并归档
    pub fn complete_item(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<TodoCompleteResult, AppError> {
        let mut file = self.load_store_file()?;
        let index = file
            .items
            .iter()
            .position(|item| item.id == id)
            .ok_or_else(|| {
                todo_error(
                    "todoItemNotFound",
                    format!("待办 {id} 不存在"),
                    Some(("itemId", id)),
                )
            })?;
        let item = file.items[index].clone();
        let list_name = file
            .lists
            .iter()
            .find(|list| list.id == item.list_id)
            .map(|list| list.name.clone())
            .unwrap_or_default();
        let entry = TodoArchiveEntry {
            id: item.id.clone(),
            list_id: item.list_id.clone(),
            list_name,
            title: item.title.clone(),
            pinned: item.pinned,
            tag_ids: item.tag_ids.clone(),
            due_date: item.due_date,
            remind_at: item.remind_at,
            completed_at: now,
            created_at: item.created_at,
        };

        let next_item = match &item.recurrence {
            None => {
                file.items.remove(index);
                None
            }
            Some(rule) => {
                let today = now.date_naive();
                let after = item.due_date.map_or(today, |due| due.max(today));
                match advance_occurrence(after, rule) {
                    Some(next_due) => {
                        // 提醒随归档那期的目标日整体平移，落到下一期的同一时刻
                        let remind_base = item.due_date.unwrap_or(after);
                        let delta = (next_due - remind_base).num_days();
                        let target = &mut file.items[index];
                        target.due_date = Some(next_due);
                        target.remind_at = shift_reminder(item.remind_at, delta);
                        target.updated_at = now;
                        Some(target.clone())
                    }
                    // 周期已结束：模板与普通待办一样整体归档
                    None => {
                        file.items.remove(index);
                        None
                    }
                }
            }
        };

        // 先写归档再写活跃集合：两步之间崩溃最多产生一条可重复归档的活跃待办，
        // 反序则可能丢条目
        let mut archive = self.load_archive_file()?;
        archive.entries.push(entry.clone());
        self.save_archive_file(&archive)?;
        self.save_store_file(&file)?;

        Ok(TodoCompleteResult {
            archived: entry,
            next_item,
        })
    }

    /// 撤销完成：把最近一次归档条目放回活跃集合。重复模板仍在活跃集合中，
    /// 恢复的只是“某一期”的快照，因此恢复项不携带重复规则，避免出现双模板
    pub fn restore_archive_entry(
        &self,
        entry_id: &str,
        now: DateTime<Utc>,
    ) -> Result<TodoItem, AppError> {
        let mut archive = self.load_archive_file()?;
        let index = archive
            .entries
            .iter()
            .rposition(|entry| entry.id == entry_id)
            .ok_or_else(|| {
                todo_error(
                    "todoArchiveEntryNotFound",
                    format!("归档条目 {entry_id} 不存在"),
                    Some(("entryId", entry_id)),
                )
            })?;
        let entry = archive.entries.remove(index);
        let mut file = self.load_store_file()?;
        if !file.lists.iter().any(|list| list.id == entry.list_id) {
            return Err(todo_error(
                "todoListNotFound",
                format!("清单 {} 不存在", entry.list_id),
                Some(("listId", entry.list_id.as_str())),
            ));
        }
        let sort_order = next_sort_order(&file.items, &entry.list_id);
        let item = TodoItem {
            id: entry.id,
            list_id: entry.list_id,
            title: entry.title,
            pinned: entry.pinned,
            sort_order,
            tag_ids: entry
                .tag_ids
                .iter()
                .filter(|id| file.tags.iter().any(|tag| &tag.id == *id))
                .cloned()
                .collect(),
            due_date: entry.due_date,
            remind_at: entry.remind_at,
            recurrence: None,
            created_at: entry.created_at,
            updated_at: now,
        };
        file.items.push(item.clone());
        self.save_archive_file(&archive)?;
        self.save_store_file(&file)?;
        Ok(item)
    }

    pub fn query_archive(
        &self,
        from: Option<NaiveDate>,
        to: Option<NaiveDate>,
    ) -> Result<Vec<TodoArchiveEntry>, AppError> {
        let mut entries = self.load_archive_file()?.entries;
        entries.retain(|entry| {
            let date = entry.completed_at.date_naive();
            from.is_none_or(|f| date >= f) && to.is_none_or(|t| date <= t)
        });
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.completed_at));
        Ok(entries)
    }

    /// 到期未完成的重复待办：冻结一份逾期快照（普通待办语义）留在原日期，
    /// 模板推进到第一个 >= today 的周期并继续重复；跳过错过的中间期。
    /// 返回本轮新产生的逾期快照。周期已结束的模板退化为普通待办
    pub fn spawn_due(
        &self,
        today: NaiveDate,
        now: DateTime<Utc>,
    ) -> Result<Vec<TodoItem>, AppError> {
        let mut file = self.load_store_file()?;
        let mut spawned: Vec<TodoItem> = Vec::new();
        let mut dirty = false;
        for item in file.items.iter_mut() {
            let Some(rule) = item.recurrence.clone() else {
                continue;
            };
            let Some(due) = item.due_date else {
                continue;
            };
            if due >= today {
                continue;
            }
            match next_due_on_or_after(due, today, &rule) {
                None => {
                    item.recurrence = None;
                    item.updated_at = now;
                    dirty = true;
                }
                Some(next_due) => {
                    let mut overdue = item.clone();
                    overdue.id = Uuid::new_v4().to_string();
                    overdue.recurrence = None;
                    // 逾期快照的提醒时刻已过期，且提醒去重状态属于模板时间线，不随快照复制
                    overdue.remind_at = None;
                    overdue.created_at = now;
                    overdue.updated_at = now;
                    spawned.push(overdue);

                    let delta = (next_due - due).num_days();
                    item.due_date = Some(next_due);
                    item.remind_at = shift_reminder(item.remind_at, delta);
                    item.updated_at = now;
                    dirty = true;
                }
            }
        }
        if !dirty {
            return Ok(spawned);
        }
        file.items.extend(spawned.iter().cloned());
        self.save_store_file(&file)?;
        Ok(spawned)
    }
}

fn next_sort_order(items: &[TodoItem], list_id: &str) -> i32 {
    items
        .iter()
        .filter(|item| item.list_id == list_id)
        .map(|item| item.sort_order)
        .max()
        .unwrap_or(-1)
        + 1
}

fn resolve_due_date(
    due_date: Option<NaiveDate>,
    recurrence: &Option<TodoRecurrenceRule>,
    now: DateTime<Utc>,
) -> Option<NaiveDate> {
    match (due_date, recurrence) {
        (Some(due), _) => Some(due),
        // 重复待办必须有目标日才可推进：缺省时从锚定日起推导第一个 >= 今天的出现日
        (None, Some(rule)) => Some(first_occurrence_on_or_after(rule, now.date_naive())),
        (None, None) => None,
    }
}

/// 宽松重排的核心：按 ordered_ids 中的出现顺序赋 0..n，
/// 未提及者按传入时的相对顺序排在全部提及者之后
fn apply_reorder(entries: &mut [(String, i32)], ordered_ids: &[String]) {
    let mut next_order = 0i32;
    for id in ordered_ids {
        if let Some(entry) = entries.iter_mut().find(|(entry_id, _)| entry_id == id) {
            entry.1 = next_order;
            next_order += 1;
        }
    }
    for entry in entries.iter_mut() {
        if !ordered_ids.contains(&entry.0) {
            entry.1 = next_order;
            next_order += 1;
        }
    }
}

fn back_up_corrupt(path: &Path) {
    let corrupt_name = format!(
        "{}.corrupt-{}.json",
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("todos"),
        Utc::now().format("%Y%m%d%H%M%S")
    );
    if let Some(parent) = path.parent() {
        if let Err(error) = fs::rename(path, parent.join(&corrupt_name)) {
            eprintln!("failed to back up corrupt {}: {error}", path.display());
        }
    }
}

/// 从 `after` 起推进到第一个 >= today 的出现日；周期在 today 之前结束则 None
fn next_due_on_or_after(
    after: NaiveDate,
    today: NaiveDate,
    rule: &TodoRecurrenceRule,
) -> Option<NaiveDate> {
    let mut current = after;
    loop {
        if current >= today {
            return Some(current);
        }
        current = advance_occurrence(current, rule)?;
    }
}

fn first_occurrence_on_or_after(rule: &TodoRecurrenceRule, from: NaiveDate) -> NaiveDate {
    next_due_on_or_after(rule.anchor_date, from, rule).unwrap_or(rule.anchor_date)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn test_root(name: &str) -> PathBuf {
        let base = std::env::var_os("FLORAL_NOTEPAPER_TEST_TEMP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("floral-notepaper-rust-tests"));
        let root = base.join(name);
        if root.exists() {
            fs::remove_dir_all(&root).expect("remove stale test root");
        }
        fs::create_dir_all(&root).expect("create test root");
        root
    }

    fn test_store(name: &str) -> TodoStore {
        // 前缀隔离：notes 测试共用同一临时目录基座，重名根目录会在并行执行时互相清空
        TodoStore::new(test_root(&format!("todo-{name}")))
    }

    fn date(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).expect("valid date")
    }

    fn at(year: i32, month: u32, day: u32, hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(year, month, day, hour, 0, 0).unwrap()
    }

    fn item_request(list_id: &str, title: &str) -> SaveTodoItemRequest {
        SaveTodoItemRequest {
            list_id: list_id.to_string(),
            title: title.to_string(),
            pinned: false,
            tag_ids: Vec::new(),
            due_date: None,
            remind_at: None,
            recurrence: None,
        }
    }

    fn list_request(name: &str) -> CreateTodoListRequest {
        CreateTodoListRequest {
            name: name.to_string(),
            default_tag_ids: Vec::new(),
        }
    }

    fn daily_rule(anchor: NaiveDate) -> TodoRecurrenceRule {
        TodoRecurrenceRule {
            freq: TodoRecurrenceFreq::Daily,
            interval: 1,
            by_weekdays: Vec::new(),
            anchor_date: anchor,
            end_date: None,
        }
    }

    #[test]
    fn creates_lists_items_and_auto_tags() {
        let store = test_store("crud");
        let now = at(2026, 9, 14, 9);

        let work = store
            .create_list(list_request("工作"), now)
            .and_then(|list| store.rename_list(&list.id, "工作清单", now))
            .expect("create and rename list");
        assert_eq!(work.name, "工作清单");

        let urgent = store
            .create_tag(
                CreateTodoTagRequest {
                    name: "紧急".into(),
                    color: "#e2725b".into(),
                },
                now,
            )
            .expect("create tag");
        let job = store
            .create_tag(
                CreateTodoTagRequest {
                    name: "工作".into(),
                    color: "#8fbf9f".into(),
                },
                now,
            )
            .expect("create default tag");
        let life = store
            .create_list(
                CreateTodoListRequest {
                    name: "生活".into(),
                    default_tag_ids: vec![job.id.clone()],
                },
                now,
            )
            .expect("create list with default tag");

        let mut request = item_request(&life.id, " 买菜 ");
        request.tag_ids = vec![urgent.id.clone()];
        let item = store.create_item(request, now).expect("create item");
        // 标题去首尾空白；手工标签在前，清单默认标签补在后
        assert_eq!(item.title, "买菜");
        assert_eq!(item.tag_ids, vec![urgent.id.clone(), job.id.clone()]);
        assert_eq!(item.sort_order, 0);

        let mut request = item_request(&work.id, "写周报");
        request.due_date = Some(date(2026, 9, 20));
        let second = store.create_item(request, now).expect("create second item");
        assert_eq!(second.due_date, Some(date(2026, 9, 20)));

        assert_eq!(store.list_lists().expect("lists").len(), 2);
        assert_eq!(store.list_items(None).expect("items").len(), 2);
        let life_items = store.list_items(Some(&life.id)).expect("life items");
        assert_eq!(life_items.len(), 1);
        assert_eq!(life_items[0].id, item.id);

        // 换清单时目标清单的默认标签同样自动补上
        let moved = store
            .update_item(&second.id, item_request(&life.id, "写周报"), now)
            .expect("move item");
        assert_eq!(moved.list_id, life.id);
        assert_eq!(moved.tag_ids, vec![job.id.clone()]);
    }

    #[test]
    fn rejects_invalid_names_titles_and_unknown_references() {
        let store = test_store("validation");
        let now = at(2026, 9, 14, 9);

        assert!(store.create_list(list_request("  "), now).is_err());

        let list = store
            .create_list(list_request("清单"), now)
            .expect("create list");
        assert!(store.create_list(list_request("清单"), now).is_err());

        assert!(store
            .create_item(item_request(&list.id, "   "), now)
            .is_err());
        assert!(store
            .create_item(item_request("missing-list", "无清单"), now)
            .is_err());

        let mut request = item_request(&list.id, "未知标签");
        request.tag_ids = vec!["missing-tag".into()];
        assert!(store.create_item(request, now).is_err());

        let mut rule = daily_rule(date(2026, 9, 14));
        rule.end_date = Some(date(2026, 9, 1));
        let mut request = item_request(&list.id, "非法重复规则");
        request.recurrence = Some(rule);
        let error = store
            .create_item(request, now)
            .expect_err("invalid recurrence");
        assert_eq!(error.code, "todoRecurrenceInvalid");
    }

    #[test]
    fn updates_reorders_and_pins_items() {
        let store = test_store("reorder");
        let now = at(2026, 9, 14, 9);

        let list = store
            .create_list(list_request("清单"), now)
            .expect("create list");
        let a = store
            .create_item(item_request(&list.id, "A"), now)
            .expect("a");
        let b = store
            .create_item(item_request(&list.id, "B"), now)
            .expect("b");
        let c = store
            .create_item(item_request(&list.id, "C"), now)
            .expect("c");

        let ordered = store
            .reorder_items(
                &list.id,
                &[c.id.clone(), a.id.clone(), "stale-id".into()],
                now,
            )
            .expect("reorder");
        let titles: Vec<&str> = ordered.iter().map(|item| item.title.as_str()).collect();
        // 未提及的 B 排在提及者之后，保持原相对顺序
        assert_eq!(titles, vec!["C", "A", "B"]);

        let pinned = store.set_item_pinned(&b.id, true, now).expect("pin");
        assert!(pinned.pinned);

        // update 是全量替换语义，保留置顶状态需在请求中原样带回
        let mut request = item_request(&list.id, "B 改");
        request.pinned = true;
        let updated = store.update_item(&b.id, request, now).expect("update");
        assert_eq!(updated.title, "B 改");
        assert!(updated.pinned);

        let other = store
            .create_list(list_request("另一清单"), now)
            .expect("create other list");
        let moved = store
            .update_item(&b.id, item_request(&other.id, "B 改"), now)
            .expect("move across lists");
        assert_eq!(moved.list_id, other.id);

        store.delete_item(&a.id).expect("delete");
        assert_eq!(store.list_items(Some(&list.id)).expect("items").len(), 1);
    }

    #[test]
    fn reorders_lists_leniently() {
        let store = test_store("reorder-lists");
        let now = at(2026, 9, 14, 9);

        let first = store.create_list(list_request("一"), now).expect("first");
        let second = store.create_list(list_request("二"), now).expect("second");
        let third = store.create_list(list_request("三"), now).expect("third");

        let lists = store
            .reorder_lists(
                &[third.id.clone(), "stale-id".into(), first.id.clone()],
                now,
            )
            .expect("reorder lists");
        let names: Vec<&str> = lists.iter().map(|list| list.name.as_str()).collect();
        // 未提及的「二」排到末尾
        assert_eq!(names, vec!["三", "一", "二"]);
        assert_eq!(
            lists
                .iter()
                .find(|list| list.id == second.id)
                .expect("second")
                .sort_order,
            2
        );
    }

    #[test]
    fn completes_plain_item_to_archive_and_restores() {
        let store = test_store("archive");
        let now = at(2026, 9, 14, 10);

        let list = store
            .create_list(list_request("本周"), now)
            .expect("create list");
        let tag = store
            .create_tag(
                CreateTodoTagRequest {
                    name: "标签".into(),
                    color: String::new(),
                },
                now,
            )
            .expect("create tag");
        let mut request = item_request(&list.id, "交付报告");
        request.tag_ids = vec![tag.id.clone()];
        request.due_date = Some(date(2026, 9, 14));
        let item = store.create_item(request, now).expect("create item");

        let result = store.complete_item(&item.id, now).expect("complete");
        assert_eq!(result.archived.title, "交付报告");
        assert_eq!(result.archived.list_name, "本周");
        assert_eq!(result.archived.completed_at, now);
        assert!(result.next_item.is_none());
        assert!(store.list_items(Some(&list.id)).expect("items").is_empty());

        let week = store
            .query_archive(Some(date(2026, 9, 14)), Some(date(2026, 9, 20)))
            .expect("query week");
        assert_eq!(week.len(), 1);
        assert_eq!(week[0].id, item.id);
        assert!(store
            .query_archive(Some(date(2026, 9, 15)), None)
            .expect("query other week")
            .is_empty());

        let restored = store.restore_archive_entry(&item.id, now).expect("restore");
        assert_eq!(restored.title, "交付报告");
        assert_eq!(restored.tag_ids, vec![tag.id.clone()]);
        assert!(restored.recurrence.is_none());
        assert!(store.query_archive(None, None).expect("archive").is_empty());
        assert_eq!(store.list_items(Some(&list.id)).expect("items").len(), 1);
    }

    #[test]
    fn completing_recurring_item_archives_snapshot_and_advances_template() {
        let store = test_store("recurring-complete");
        let now = at(2026, 9, 14, 10);

        let list = store
            .create_list(list_request("清单"), now)
            .expect("create list");
        let mut request = item_request(&list.id, "每日站会");
        request.due_date = Some(date(2026, 9, 12));
        request.remind_at = Some(at(2026, 9, 12, 9));
        request.recurrence = Some(daily_rule(date(2026, 9, 12)));
        let item = store.create_item(request, now).expect("create item");

        let result = store.complete_item(&item.id, now).expect("complete");

        // 归档的是 9/12 那一期，模板推进到严格晚于今天（9/15）
        assert_eq!(result.archived.due_date, Some(date(2026, 9, 12)));
        let next = result.next_item.expect("recurring keeps template");
        assert_eq!(next.id, item.id);
        assert_eq!(next.due_date, Some(date(2026, 9, 15)));
        assert_eq!(next.remind_at, Some(at(2026, 9, 15, 9)));

        let items = store.list_items(Some(&list.id)).expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].due_date, Some(date(2026, 9, 15)));
    }

    #[test]
    fn completing_recurring_item_past_end_archives_template() {
        let store = test_store("recurring-ended");
        let now = at(2026, 9, 14, 10);

        let list = store
            .create_list(list_request("清单"), now)
            .expect("create list");
        let mut rule = daily_rule(date(2026, 9, 10));
        rule.end_date = Some(date(2026, 9, 10));
        let mut request = item_request(&list.id, "限时任务");
        request.due_date = Some(date(2026, 9, 10));
        request.recurrence = Some(rule);
        let item = store.create_item(request, now).expect("create item");

        let result = store.complete_item(&item.id, now).expect("complete");
        assert!(result.next_item.is_none());
        assert!(store.list_items(Some(&list.id)).expect("items").is_empty());
    }

    #[test]
    fn deleting_list_cascades_items_but_keeps_archive_snapshot() {
        let store = test_store("list-delete");
        let now = at(2026, 9, 14, 10);

        let list = store
            .create_list(list_request("临时项目"), now)
            .expect("create list");
        let item = store
            .create_item(item_request(&list.id, "收尾"), now)
            .expect("create item");
        store.complete_item(&item.id, now).expect("complete");
        store
            .create_item(item_request(&list.id, "未完成"), now)
            .expect("create pending item");

        store.delete_list(&list.id).expect("delete list");
        assert!(store.list_items(None).expect("items").is_empty());
        assert!(store.list_lists().expect("lists").is_empty());

        let archive = store.query_archive(None, None).expect("archive");
        assert_eq!(archive.len(), 1);
        assert_eq!(archive[0].list_name, "临时项目");
    }

    #[test]
    fn set_list_default_tags_validates_and_applies() {
        let store = test_store("list-default-tags");
        let now = at(2026, 9, 14, 10);

        let tag = store
            .create_tag(
                CreateTodoTagRequest {
                    name: "工作".into(),
                    color: String::new(),
                },
                now,
            )
            .expect("create tag");
        let list = store
            .create_list(list_request("清单"), now)
            .expect("create list");

        let updated = store
            .set_list_default_tags(&list.id, std::slice::from_ref(&tag.id), now)
            .expect("set default tags");
        assert_eq!(updated.default_tag_ids, vec![tag.id.clone()]);

        // 新建待办自动获得默认标签
        let item = store
            .create_item(item_request(&list.id, "任务"), now)
            .expect("create item");
        assert_eq!(item.tag_ids, vec![tag.id.clone()]);

        assert!(store
            .set_list_default_tags(&list.id, &["missing".into()], now)
            .is_err());
        assert!(store.set_list_default_tags("missing", &[], now).is_err());
    }

    #[test]
    fn deleting_tag_strips_references() {
        let store = test_store("tag-delete");
        let now = at(2026, 9, 14, 10);

        let tag = store
            .create_tag(
                CreateTodoTagRequest {
                    name: "紧急".into(),
                    color: String::new(),
                },
                now,
            )
            .expect("create tag");
        let list = store
            .create_list(
                CreateTodoListRequest {
                    name: "清单".into(),
                    default_tag_ids: vec![tag.id.clone()],
                },
                now,
            )
            .expect("create list");
        let item = store
            .create_item(item_request(&list.id, "任务"), now)
            .expect("create item");
        assert_eq!(item.tag_ids, vec![tag.id.clone()]);

        store.delete_tag(&tag.id).expect("delete tag");
        let lists = store.list_lists().expect("lists");
        assert!(lists[0].default_tag_ids.is_empty());
        let items = store.list_items(None).expect("items");
        assert!(items[0].tag_ids.is_empty());
    }

    #[test]
    fn rebuilds_when_todos_json_is_corrupt() {
        let store = test_store("corrupt");
        let now = at(2026, 9, 14, 10);
        let list = store
            .create_list(list_request("清单"), now)
            .expect("create list");
        store
            .create_item(item_request(&list.id, "任务"), now)
            .expect("create item");

        fs::write(store.todos_path(), "{ broken json").expect("corrupt todos");

        assert!(store.list_lists().expect("recovered lists").is_empty());
        assert!(store.list_items(None).expect("recovered items").is_empty());
        let backed_up = fs::read_dir(store.data_dir())
            .expect("read data dir")
            .filter_map(|entry| entry.ok())
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("todos.corrupt-")
            });
        assert!(backed_up, "corrupt todos.json should be backed up");

        // 恢复后可继续写入
        store
            .create_list(list_request("新清单"), now)
            .expect("create after recovery");
    }

    #[test]
    fn recurrence_daily_and_interval_advance() {
        let rule = TodoRecurrenceRule {
            freq: TodoRecurrenceFreq::Daily,
            interval: 2,
            ..daily_rule(date(2026, 9, 10))
        };
        assert_eq!(
            advance_occurrence(date(2026, 9, 10), &rule),
            Some(date(2026, 9, 12))
        );
        assert_eq!(
            advance_occurrence(date(2026, 9, 12), &rule),
            Some(date(2026, 9, 14))
        );
    }

    #[test]
    fn recurrence_weekly_by_weekdays_honors_interval_anchor() {
        // 2026-08-31 与 2026-09-14 均为周一；by_weekdays 0 = 周一
        let mut rule = daily_rule(date(2026, 8, 31));
        rule.freq = TodoRecurrenceFreq::Weekly;
        rule.interval = 2;
        rule.by_weekdays = vec![0];
        assert_eq!(
            advance_occurrence(date(2026, 8, 31), &rule),
            Some(date(2026, 9, 14))
        );
        assert_eq!(
            advance_occurrence(date(2026, 9, 14), &rule),
            Some(date(2026, 9, 28))
        );
        // 从周中出发也落到下一个有效周一
        assert_eq!(
            advance_occurrence(date(2026, 9, 15), &rule),
            Some(date(2026, 9, 28))
        );
    }

    #[test]
    fn recurrence_monthly_clamps_and_yearly_handles_leap() {
        let mut monthly = daily_rule(date(2026, 1, 31));
        monthly.freq = TodoRecurrenceFreq::Monthly;
        assert_eq!(
            advance_occurrence(date(2026, 1, 31), &monthly),
            Some(date(2026, 2, 28))
        );

        let mut yearly = daily_rule(date(2028, 2, 29));
        yearly.freq = TodoRecurrenceFreq::Yearly;
        assert_eq!(
            advance_occurrence(date(2028, 2, 29), &yearly),
            Some(date(2029, 2, 28))
        );
    }

    #[test]
    fn recurrence_end_date_stops_series() {
        let mut rule = daily_rule(date(2026, 9, 10));
        rule.end_date = Some(date(2026, 9, 10));
        assert_eq!(advance_occurrence(date(2026, 9, 10), &rule), None);
    }

    #[test]
    fn recurrence_normalization_clamps_interval_and_weekdays() {
        let mut rule = daily_rule(date(2026, 9, 14));
        rule.interval = 0;
        rule.by_weekdays = vec![9, 3, 3, 1];
        let normalized = rule.normalized().expect("normalize");
        assert_eq!(normalized.interval, 1);
        assert_eq!(normalized.by_weekdays, vec![1, 3]);
    }

    #[test]
    fn creating_recurring_item_without_due_derives_from_anchor() {
        let store = test_store("derive-due");
        let now = at(2026, 9, 14, 9);

        let list = store
            .create_list(list_request("清单"), now)
            .expect("create list");
        let mut rule = daily_rule(date(2026, 8, 31));
        rule.freq = TodoRecurrenceFreq::Weekly;
        rule.by_weekdays = vec![0];
        let mut request = item_request(&list.id, "周会");
        request.recurrence = Some(rule);
        let item = store.create_item(request, now).expect("create item");
        // 锚定 8/31 周一，第一个 >= 9/14（周一）的出现日就是 9/14
        assert_eq!(item.due_date, Some(date(2026, 9, 14)));
    }

    #[test]
    fn spawn_due_freezes_overdue_copy_and_advances_template() {
        let store = test_store("spawn");
        let now = at(2026, 9, 14, 10);
        let today = date(2026, 9, 14);

        let list = store
            .create_list(list_request("清单"), now)
            .expect("create list");
        let mut request = item_request(&list.id, "背单词");
        request.due_date = Some(date(2026, 9, 10));
        request.remind_at = Some(at(2026, 9, 10, 8));
        request.recurrence = Some(daily_rule(date(2026, 9, 10)));
        let item = store.create_item(request, now).expect("create item");

        let spawned = store.spawn_due(today, now).expect("spawn");
        // 错过 9/11-9/13 三期只补最新一期：仅一份逾期快照 + 模板推进到今天
        assert_eq!(spawned.len(), 1);
        let overdue = &spawned[0];
        assert_ne!(overdue.id, item.id);
        assert_eq!(overdue.due_date, Some(date(2026, 9, 10)));
        assert!(overdue.recurrence.is_none());
        assert!(overdue.remind_at.is_none());
        assert_eq!(overdue.title, "背单词");

        let items = store.list_items(Some(&list.id)).expect("items");
        assert_eq!(items.len(), 2);
        let template = items.iter().find(|i| i.id == item.id).expect("template");
        assert_eq!(template.due_date, Some(today));
        assert_eq!(template.remind_at, Some(at(2026, 9, 14, 8)));

        // 幂等：模板已推进到今天，再次 spawn 不再产生快照
        let again = store.spawn_due(today, now).expect("spawn again");
        assert!(again.is_empty());
    }

    #[test]
    fn spawn_due_downgrades_lapsed_series_to_plain_item() {
        let store = test_store("spawn-lapsed");
        let now = at(2026, 9, 14, 10);
        let today = date(2026, 9, 14);

        let list = store
            .create_list(list_request("清单"), now)
            .expect("create list");
        let mut rule = daily_rule(date(2026, 9, 1));
        rule.end_date = Some(date(2026, 9, 5));
        let mut request = item_request(&list.id, "短期打卡");
        request.due_date = Some(date(2026, 9, 5));
        request.recurrence = Some(rule);
        store.create_item(request, now).expect("create item");

        let spawned = store.spawn_due(today, now).expect("spawn");
        assert!(spawned.is_empty());
        let items = store.list_items(Some(&list.id)).expect("items");
        assert_eq!(items.len(), 1);
        assert!(items[0].recurrence.is_none());
        assert_eq!(items[0].due_date, Some(date(2026, 9, 5)));
    }

    #[test]
    fn query_archive_sorts_desc_and_filters_by_range() {
        let store = test_store("archive-query");
        let now = at(2026, 9, 14, 10);

        let list = store
            .create_list(list_request("清单"), now)
            .expect("create list");
        let older = store
            .create_item(item_request(&list.id, "旧任务"), now)
            .expect("create older");
        let newer = store
            .create_item(item_request(&list.id, "新任务"), now)
            .expect("create newer");

        store
            .complete_item(&older.id, at(2026, 9, 10, 18))
            .expect("complete older");
        store
            .complete_item(&newer.id, at(2026, 9, 12, 18))
            .expect("complete newer");

        let all = store.query_archive(None, None).expect("query all");
        assert_eq!(
            all.iter()
                .map(|entry| entry.title.as_str())
                .collect::<Vec<_>>(),
            vec!["新任务", "旧任务"]
        );
        let partial = store
            .query_archive(Some(date(2026, 9, 11)), None)
            .expect("query partial");
        assert_eq!(partial.len(), 1);
        assert_eq!(partial[0].title, "新任务");
    }
}
