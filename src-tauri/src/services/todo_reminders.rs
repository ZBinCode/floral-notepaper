use super::todos::{self, TodoItem};
use crate::json_io::write_json_atomic;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::PathBuf, thread, time::Duration};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

const INITIAL_DELAY: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_secs(30);
/// 已提醒记录保留 7 天：既限制文件增长，也让“改回同一提醒时刻”在一周内不重响
const FIRED_RETENTION: ChronoDuration = ChronoDuration::days(7);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReminderStateFile {
    /// key = "{itemId}:{remindAt rfc3339}"，value = 触发时的 unix 秒
    #[serde(default)]
    fired: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderEventDto {
    pub item_id: String,
    pub title: String,
}

/// 提醒调度：std::thread + sleep 轮询（与 updater 调度器同构）。
/// 关机期间错过的提醒会在下次轮询统一补发（每条只响一次，靠持久化 fired 集合去重）
pub fn start_scheduler(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(INITIAL_DELAY);
        loop {
            if let Err(error) = poll(&app, Utc::now()) {
                eprintln!("failed to run todo reminder poll: {error}");
            }
            thread::sleep(POLL_INTERVAL);
        }
    });
}

fn poll(app: &AppHandle, now: DateTime<Utc>) -> Result<(), super::notes::AppError> {
    if !reminder_enabled() {
        return Ok(());
    }
    let store = todos::default_store()?;
    let items = store.list_items(None)?;
    let state_path = store.data_dir().join("todo-reminders.json");
    let state = load_state(&state_path);

    let due = due_reminders(&items, now, &state.fired);
    if due.is_empty() {
        return Ok(());
    }

    let title = notification_title();
    let mut next_state = state;
    for (item, remind_at) in &due {
        fire_notification(app, &title, &item.title);
        next_state
            .fired
            .insert(fired_key(&item.id, *remind_at), now.timestamp());
        let _ = app.emit(
            "todo-reminder",
            ReminderEventDto {
                item_id: item.id.clone(),
                title: item.title.clone(),
            },
        );
    }
    prune_fired(&mut next_state.fired, now);
    write_json_atomic(&state_path, &next_state)?;
    Ok(())
}

/// 到期待办 = remind_at <= now 且未触发过（完成项已归档，不在活跃集合里）
pub(crate) fn due_reminders<'a>(
    items: &'a [TodoItem],
    now: DateTime<Utc>,
    fired: &BTreeMap<String, i64>,
) -> Vec<(&'a TodoItem, DateTime<Utc>)> {
    items
        .iter()
        .filter_map(|item| {
            let remind_at = item.remind_at?;
            if remind_at > now {
                return None;
            }
            if fired.contains_key(&fired_key(&item.id, remind_at)) {
                return None;
            }
            Some((item, remind_at))
        })
        .collect()
}

fn fired_key(item_id: &str, remind_at: DateTime<Utc>) -> String {
    format!("{item_id}:{}", remind_at.to_rfc3339())
}

fn prune_fired(fired: &mut BTreeMap<String, i64>, now: DateTime<Utc>) {
    let cutoff = now.timestamp() - FIRED_RETENTION.num_seconds();
    fired.retain(|_, fired_at| *fired_at >= cutoff);
}

fn load_state(path: &PathBuf) -> ReminderStateFile {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

/// 轻量读取配置：只反序列化需要的两个字段，避免轮询走 load_config 的整文件回写。
/// 字段缺失（旧配置）按默认开启处理
fn reminder_enabled() -> bool {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PartialConfig {
        todo_reminder_enabled: Option<bool>,
    }
    let Ok(config_dir) = super::notes::default_config_dir() else {
        return true;
    };
    fs::read_to_string(config_dir.join("config.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<PartialConfig>(&content).ok())
        .and_then(|partial| partial.todo_reminder_enabled)
        .unwrap_or(true)
}

fn notification_title() -> String {
    let locale = reminder_locale();
    crate::locales::todo_board_window_title(locale).to_string()
}

fn reminder_locale() -> crate::locales::Locale {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PartialConfig {
        locale: Option<String>,
    }
    let Ok(config_dir) = super::notes::default_config_dir() else {
        return crate::locales::Locale::default();
    };
    fs::read_to_string(config_dir.join("config.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<PartialConfig>(&content).ok())
        .and_then(|partial| partial.locale)
        .map(|tag| crate::locales::Locale::from_tag(&tag))
        .unwrap_or_default()
}

fn fire_notification(app: &AppHandle, title: &str, body: &str) {
    if let Err(error) = app.notification().builder().title(title).body(body).show() {
        eprintln!("failed to show todo reminder notification: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(day: u32, hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, day, hour, 0, 0).unwrap()
    }

    fn item_with(id: &str, remind_at: Option<DateTime<Utc>>) -> TodoItem {
        TodoItem {
            id: id.to_string(),
            list_id: "list-1".to_string(),
            title: format!("待办 {id}"),
            pinned: false,
            sort_order: 0,
            tag_ids: Vec::new(),
            due_date: None,
            remind_at,
            recurrence: None,
            created_at: at(1, 0),
            updated_at: at(1, 0),
        }
    }

    #[test]
    fn due_reminders_only_include_unfired_past_reminders() {
        let now = at(14, 10);
        let items = [
            item_with("a", Some(at(14, 9))),
            item_with("b", Some(at(14, 11))),
            item_with("c", None),
            item_with("d", Some(at(13, 9))),
        ];

        let mut fired = BTreeMap::new();
        fired.insert(fired_key("d", at(13, 9)), now.timestamp());

        let due = due_reminders(&items, now, &fired);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0.id, "a");
        assert_eq!(due[0].1, at(14, 9));
    }

    #[test]
    fn same_reminder_moment_can_fire_again_after_key_changes() {
        let now = at(14, 10);
        let items = [item_with("a", Some(at(14, 9)))];
        assert_eq!(due_reminders(&items, now, &BTreeMap::new()).len(), 1);

        // 触发后记录 fired key，同一时刻不再响
        let mut fired = BTreeMap::new();
        fired.insert(fired_key("a", at(14, 9)), now.timestamp());
        assert!(due_reminders(&items, now, &fired).is_empty());
    }

    #[test]
    fn prune_fired_drops_entries_older_than_retention() {
        let now = at(14, 10);
        let mut fired = BTreeMap::new();
        fired.insert(
            "old".to_string(),
            (now - ChronoDuration::days(8)).timestamp(),
        );
        fired.insert(
            "fresh".to_string(),
            (now - ChronoDuration::days(1)).timestamp(),
        );

        prune_fired(&mut fired, now);
        assert_eq!(fired.len(), 1);
        assert!(fired.contains_key("fresh"));
    }
}
