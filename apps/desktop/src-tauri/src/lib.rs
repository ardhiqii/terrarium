//! Terrarium desktop companion: a transparent, click-through strip docked
//! just above the taskbar, plus a tray menu. The webview (`../src`) does the
//! drawing; this side positions the window, owns the tray, and makes the one
//! network call (the API sends no CORS headers for the webview's origin).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// Strip height in logical pixels: room for a 96px sprite plus its bubble.
const STRIP_HEIGHT: f64 = 150.0;
/// While the settings form is open the strip grows so the whole form fits.
const STRIP_HEIGHT_FORM: f64 = 340.0;
/// Whether the settings form is open, so a re-dock keeps the right height.
static FORM_OPEN: AtomicBool = AtomicBool::new(false);
/// The API answers in a few KB; anything far larger is not a creature.
const MAX_BODY_BYTES: u64 = 256 * 1024;

/// Only https, or plain http on this machine (a local `npm run dev`).
fn allowed_base(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "That Terrarium address is not a valid URL.".to_string())?;
    let local = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"));
    let ok = match url.scheme() {
        "https" => true,
        "http" => local,
        _ => false,
    };
    if !ok || !url.username().is_empty() || url.password().is_some() {
        return Err("The Terrarium address must be https (or http://localhost).".into());
    }
    Ok(url)
}

/// GitHub's own rules: logins are 1-39 of `[A-Za-z0-9-]`, repo names 1-100 of `[A-Za-z0-9._-]`.
fn valid_login(s: &str) -> bool {
    (1..=39).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}
fn valid_repo(s: &str) -> bool {
    (1..=100).contains(&s.len())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && s != "."
        && s != ".."
}

#[tauri::command]
async fn fetch_creature(api_base: String, user: String, repo: String) -> Result<serde_json::Value, String> {
    let mut url = allowed_base(&api_base)?;
    let user = user.trim().to_string();
    let repo = repo.trim().to_string();
    if !valid_login(&user) {
        return Err("That does not look like a GitHub username.".into());
    }
    if !valid_repo(&repo) {
        return Err("That does not look like a repository name.".into());
    }
    url.set_path("/api/creature");
    url.query_pairs_mut().clear().append_pair("user", &user).append_pair("repo", &repo);

    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(10))
            .redirects(0)
            .user_agent("terrarium-desktop")
            .build();
        let response = match agent.get(url.as_str()).call() {
            Ok(r) => r,
            Err(ureq::Error::Status(404, _)) => return Err("Terrarium could not find that user or repository.".into()),
            Err(ureq::Error::Status(code, _)) => return Err(format!("Terrarium answered with an error ({code}).")),
            Err(_) => return Err("Could not reach Terrarium. Check the address and your connection.".into()),
        };
        let mut body = String::new();
        use std::io::Read;
        response
            .into_reader()
            .take(MAX_BODY_BYTES + 1)
            .read_to_string(&mut body)
            .map_err(|_| "Terrarium's answer could not be read.".to_string())?;
        if body.len() as u64 > MAX_BODY_BYTES {
            return Err("Terrarium's answer was unexpectedly large.".into());
        }
        serde_json::from_str(&body).map_err(|_| "Terrarium's answer was not understood.".to_string())
    })
    .await
    .map_err(|_| "The request was interrupted.".to_string())?
}

/// Open the Terrarium `/repos` page of the configured address in the browser.
/// Takes only the base: the path is fixed here, so the webview cannot open
/// arbitrary pages even if its script were ever compromised.
#[tauri::command]
fn open_external(app: AppHandle, api_base: String) -> Result<(), String> {
    let mut url = allowed_base(&api_base)?;
    url.set_path("/repos");
    url.set_query(None);
    url.set_fragment(None);
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| "Could not open the browser.".to_string())
}

/// Grow the strip while the settings form is open, shrink it back after.
#[tauri::command]
fn set_form_open(window: WebviewWindow, open: bool) -> Result<(), String> {
    FORM_OPEN.store(open, Ordering::Relaxed);
    dock_to_taskbar(&window).map_err(|_| "Could not resize the window.".to_string())
}

/// Stretch the window across the primary monitor's work area, resting on the taskbar.
fn dock_to_taskbar(window: &WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.primary_monitor()? else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let logical = if FORM_OPEN.load(Ordering::Relaxed) { STRIP_HEIGHT_FORM } else { STRIP_HEIGHT };
    let height = (logical * scale).round() as u32;
    window.set_size(PhysicalSize::new(area.size.width, height))?;
    let y = area.position.y + area.size.height as i32 - height as i32;
    window.set_position(PhysicalPosition::new(area.position.x, y))?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![fetch_creature, open_external, set_form_open])
        // A DPI or resolution change moves the work area; follow it.
        .on_window_event(|window, event| {
            if let WindowEvent::ScaleFactorChanged { .. } = event {
                if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                    let _ = dock_to_taskbar(&webview);
                }
            }
        })
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window is declared in tauri.conf.json");
            dock_to_taskbar(&window)?;
            window.set_ignore_cursor_events(true)?;
            window.show()?;

            let open = MenuItem::with_id(app, "open", "Open Terrarium", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Change companion…", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let quiet = CheckMenuItem::with_id(app, "quiet", "Quiet mode (hide)", true, false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &settings, &refresh, &quiet, &separator, &quit])?;

            let quiet_item = quiet.clone();
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Terrarium")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| {
                    let Some(window) = app.get_webview_window("main") else { return };
                    match event.id().as_ref() {
                        "open" => {
                            let _ = app.emit("terrarium://open", ());
                        }
                        "settings" => {
                            let _ = quiet_item.set_checked(false);
                            let _ = window.show();
                            let _ = app.emit("terrarium://settings", ());
                        }
                        "refresh" => {
                            let _ = app.emit("terrarium://refresh", ());
                        }
                        "quiet" => {
                            if quiet_item.is_checked().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = dock_to_taskbar(&window);
                                let _ = window.show();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Terrarium desktop companion");
}
