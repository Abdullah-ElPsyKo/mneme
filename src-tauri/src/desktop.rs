use crate::{
    backend::Backend,
    preferences::{is_within, validate_brain, CloseBehavior, Preferences},
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
};
use tauri::{
    ipc::CapabilityBuilder,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

struct Session {
    prefs: Preferences,
    backend: Option<Backend>,
    phase: &'static str,
    error: Option<String>,
    shortcut_error: Option<String>,
    registered_shortcut: Option<String>,
    dirty: HashSet<String>,
    suspended: Option<bool>,
    background: bool,
}
pub struct Desktop {
    session: Mutex<Session>,
    settings_path: PathBuf,
    recommended: PathBuf,
    switching: AtomicBool,
    exiting: AtomicBool,
    pause_item: CheckMenuItem<tauri::Wry>,
    status_item: MenuItem<tauri::Wry>,
}
fn state(app: &AppHandle) -> tauri::State<'_, Desktop> {
    app.state::<Desktop>()
}
fn window_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN
}
fn bootstrap_url(url: &url::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http"
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none())
}
fn same_origin(url: &url::Url, origin: &str) -> bool {
    url::Url::parse(origin).is_ok_and(|expected| url.origin() == expected.origin())
}
fn allowed_navigation(app: &AppHandle, url: &url::Url) -> bool {
    if bootstrap_url(url) {
        return true;
    }
    state(app)
        .session
        .lock()
        .unwrap()
        .backend
        .as_ref()
        .is_some_and(|backend| same_origin(url, &backend.origin))
}
fn authorize(window: &WebviewWindow, main_only: bool) -> Result<(), String> {
    if (main_only && window.label() != "main") || !["main", "capture"].contains(&window.label()) {
        return Err("This desktop operation is not available in this window.".into());
    }
    if !allowed_navigation(
        window.app_handle(),
        &window.url().map_err(|e| e.to_string())?,
    ) {
        return Err("Untrusted desktop origin.".into());
    }
    Ok(())
}
fn emit_state(app: &AppHandle) {
    let _ = app.emit("desktop-state", ());
}
fn refresh_visibility(app: &AppHandle) {
    let visible = app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
    });
    let desktop = state(app);
    let mut session = desktop.session.lock().unwrap();
    let suspended = !visible && !session.prefs.run_background_when_hidden;
    if session.suspended != Some(suspended) {
        session.suspended = Some(suspended);
        if let Some(backend) = session.backend.as_mut() {
            let _ = backend.send(json!({"type":"visibility", "suspended":suspended}));
        }
    }
    drop(session);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("desktop-visibility", visible);
    }
}
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    refresh_visibility(app);
}
fn hide_main(app: &AppHandle) {
    let _ = app.save_window_state(window_flags());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    refresh_visibility(app);
}
fn report_error(app: &AppHandle, message: String) {
    {
        let desktop = state(app);
        let mut session = desktop.session.lock().unwrap();
        session.error = Some(message);
        session.phase = "error";
    }
    emit_state(app);
    show_main(app);
}
fn allow_backend(app: &AppHandle, origin: &str, pid: u32) -> Result<(), String> {
    app.add_capability(
        CapabilityBuilder::new(format!("brain-main-{pid}"))
            .remote(format!("{origin}/*"))
            .windows(["main"])
            .permission("allow-desktop-state")
            .permission("allow-desktop-choose-brain")
            .permission("allow-desktop-preferences")
            .permission("allow-desktop-save-preferences")
            .permission("allow-desktop-finish-close")
            .permission("allow-desktop-set-dirty")
            .permission("allow-desktop-toggle-fullscreen")
            .permission("allow-desktop-open-reference")
            .permission("core:event:allow-listen")
            .permission("core:event:allow-unlisten"),
    )
    .map_err(|e| e.to_string())?;
    app.add_capability(
        CapabilityBuilder::new(format!("brain-capture-{pid}"))
            .remote(format!("{origin}/*"))
            .windows(["capture"])
            .permission("allow-desktop-state")
            .permission("allow-desktop-set-dirty")
            .permission("allow-desktop-capture-done")
            .permission("core:event:allow-listen")
            .permission("core:event:allow-unlisten"),
    )
    .map_err(|e| e.to_string())
}
fn start_brain(app: AppHandle, root: PathBuf) -> Result<(), String> {
    let desktop = state(&app);
    {
        let mut session = desktop.session.lock().unwrap();
        session.phase = "starting";
        session.error = None;
    }
    emit_state(&app);
    let (backend, receiver) = Backend::start(&app, &root)?;
    let pid = backend.pid();
    allow_backend(&app, &backend.origin, pid)?;
    let url = format!("{}/#token={}", backend.origin, backend.token)
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;
    {
        let mut session = desktop.session.lock().unwrap();
        let mut next = session.prefs.clone();
        next.brain_root = Some(backend.root.clone());
        next.write(&desktop.settings_path)?;
        session.prefs = next;
        session.backend = Some(backend);
        session.phase = "ready";
        session.suspended = None;
    }
    app.get_webview_window("main")
        .ok_or("Main window unavailable")?
        .navigate(url)
        .map_err(|e| e.to_string())?;
    refresh_visibility(&app);
    let observer = app.clone();
    thread::spawn(move || {
        while let Ok(message) = receiver.recv() {
            let desktop = state(&observer);
            let mut session = desktop.session.lock().unwrap();
            if session.backend.as_ref().map(Backend::pid) != Some(pid) {
                return;
            }
            if message["type"] == "status" {
                let background = message["background"].as_bool().unwrap_or(false);
                session.background = background;
                let label = if !background {
                    "Status · processing paused"
                } else if message["suspended"] == true {
                    "Status · resting in tray"
                } else if message["running"] == true {
                    "Status · processing"
                } else {
                    "Status · ready"
                };
                drop(session);
                let _ = desktop.pause_item.set_checked(!background);
                let _ = desktop.status_item.set_text(label);
            } else if message["type"] == "error" {
                session.error = Some(
                    message["message"]
                        .as_str()
                        .unwrap_or("Desktop control failed.")
                        .into(),
                );
                drop(session);
                emit_state(&observer);
            }
        }
        let desktop = state(&observer);
        let mut session = desktop.session.lock().unwrap();
        if session.backend.as_ref().map(Backend::pid) == Some(pid)
            && !desktop.exiting.load(Ordering::SeqCst)
        {
            session.backend.take();
            session.phase = "error";
            session.error = Some("The memory engine stopped unexpectedly. Reopen your brain to recover; saved data remains on disk.".into());
            drop(session);
            if let Some(capture) = observer.get_webview_window("capture") {
                let _ = capture.destroy();
            }
            if let Some(main) = observer.get_webview_window("main") {
                let _ = main.navigate(
                    "http://tauri.localhost/index.html?desktop=setup"
                        .parse()
                        .unwrap(),
                );
            }
            emit_state(&observer);
            show_main(&observer);
        }
    });
    Ok(())
}
fn capture(app: &AppHandle) -> Result<(), String> {
    if state(app).exiting.load(Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("capture") {
        window.show().map_err(|e| e.to_string())?;
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("desktop-capture-focus", ());
        return Ok(());
    }
    let url = {
        let desktop = state(app);
        let session = desktop.session.lock().unwrap();
        let backend = session
            .backend
            .as_ref()
            .ok_or("Open a brain before using Quick Capture.")?;
        format!("{}/?window=capture#token={}", backend.origin, backend.token)
            .parse()
            .map_err(|e: url::ParseError| e.to_string())?
    };
    let guarded = app.clone();
    let window = WebviewWindowBuilder::new(app, "capture", WebviewUrl::External(url))
        .title("Quick Capture — Mneme")
        .inner_size(500.0, 350.0)
        .min_inner_size(400.0, 300.0)
        .center()
        .theme(Some(tauri::Theme::Dark))
        .always_on_top(true)
        .skip_taskbar(true)
        .disable_drag_drop_handler()
        .on_navigation(move |url| allowed_navigation(&guarded, url))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|e| e.to_string())?;
    let clone = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = clone.hide();
        }
    });
    let _ = window.set_focus();
    Ok(())
}
fn exit_app(app: &AppHandle) {
    let desktop = state(app);
    if desktop.exiting.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.save_window_state(window_flags());
    let _ = app.emit("desktop-closing", ());
    let backend = {
        let mut session = desktop.session.lock().unwrap();
        session.phase = "closing";
        session.backend.take()
    };
    let app = app.clone();
    thread::spawn(move || {
        if let Some(backend) = backend {
            backend.shutdown();
        }
        app.exit(0);
    });
}
fn request_close(app: &AppHandle, explicit_exit: bool) {
    let desktop = state(app);
    if desktop.exiting.load(Ordering::SeqCst) {
        return;
    }
    let session = desktop.session.lock().unwrap();
    let dirty = !session.dirty.is_empty();
    let behavior = if explicit_exit {
        CloseBehavior::Exit
    } else {
        session.prefs.close_behavior.clone()
    };
    drop(session);
    if behavior == CloseBehavior::Tray {
        hide_main(app);
    } else if behavior == CloseBehavior::Ask || dirty {
        show_main(app);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit(
                "desktop-close-requested",
                json!({"dirty":dirty,"explicit_exit":explicit_exit}),
            );
        }
    } else {
        exit_app(app);
    }
}
#[tauri::command]
fn desktop_state(window: WebviewWindow) -> Result<Value, String> {
    authorize(&window, false)?;
    let desktop = state(window.app_handle());
    let session = desktop.session.lock().unwrap();
    Ok(
        json!({"phase":session.phase,"error":session.error,"shortcut_error":session.shortcut_error,
        "recommended":desktop.recommended,"root":session.prefs.brain_root,"background":session.background,
        "visible":window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)}),
    )
}
#[tauri::command]
fn desktop_preferences(window: WebviewWindow) -> Result<Preferences, String> {
    authorize(&window, true)?;
    let mut prefs = state(window.app_handle())
        .session
        .lock()
        .unwrap()
        .prefs
        .clone();
    prefs.start_with_windows = window
        .app_handle()
        .autolaunch()
        .is_enabled()
        .map_err(|e| e.to_string())?;
    Ok(prefs)
}
#[tauri::command]
async fn desktop_choose_brain(window: WebviewWindow, mode: String) -> Result<(), String> {
    authorize(&window, true)?;
    if !["recommended", "new", "existing", "reopen"].contains(&mode.as_str()) {
        return Err("Invalid brain choice.".into());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let desktop = state(&app);
        if desktop.switching.swap(true, Ordering::SeqCst) { return Err("A brain is already being opened.".into()); }
        let result = (|| {
            if !desktop.session.lock().unwrap().dirty.is_empty() { return Err("Save or discard your open drafts before changing brains.".into()); }
            let chosen = if mode == "recommended" { Some(desktop.recommended.clone()) }
                else if mode == "reopen" { desktop.session.lock().unwrap().prefs.brain_root.clone() }
                else { app.dialog().file().set_title(if mode == "existing" { "Open existing Mneme brain" } else { "Choose an empty folder for your brain" })
                    .blocking_pick_folder().and_then(|path| path.into_path().ok()) };
            let Some(chosen) = chosen else { return Ok(()); };
            let install = std::env::current_exe().map_err(|e| e.to_string())?.parent().unwrap().to_path_buf();
            let existing = mode == "existing" || mode == "reopen" || (mode == "recommended" && chosen.join("database/brain.db").is_file());
            let root = validate_brain(&chosen, &install, existing)?;
            let app_data = dunce::canonicalize(desktop.settings_path.parent().unwrap()).map_err(|e| e.to_string())?;
            if is_within(&root, &app_data) { return Err("Choose a brain folder outside Mneme's disposable application settings directory.".into()); }
            if let Some(current) = desktop.session.lock().unwrap().backend.as_ref() { if current.root == root { return Ok(()); } }
            if let Some(capture) = app.get_webview_window("capture") { let _ = capture.destroy(); }
            let previous = { let mut session = desktop.session.lock().unwrap(); session.phase = "starting"; session.backend.take() };
            if let Some(main) = app.get_webview_window("main") { let _ = main.navigate("http://tauri.localhost/index.html?desktop=setup".parse().unwrap()); }
            if let Some(previous) = previous { previous.shutdown(); }
            start_brain(app.clone(), root)
        })();
        desktop.switching.store(false, Ordering::SeqCst);
        if let Err(error) = &result { report_error(&app, error.clone()); } result
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn desktop_save_preferences(
    window: WebviewWindow,
    preferences: Preferences,
) -> Result<Preferences, String> {
    authorize(&window, true)?;
    preferences.validate()?;
    let app = window.app_handle();
    let desktop = state(app);
    let mut session = desktop.session.lock().unwrap();
    if preferences.brain_root != session.prefs.brain_root {
        return Err("Use the native brain picker to change directories.".into());
    }
    let shortcut: Shortcut = preferences
        .shortcut
        .parse()
        .map_err(|_| "Enter a shortcut such as Ctrl+Alt+Space.")?;
    if !preferences.shortcut.split('+').any(|part| {
        [
            "ctrl",
            "control",
            "alt",
            "super",
            "meta",
            "commandorcontrol",
        ]
        .contains(&part.to_ascii_lowercase().as_str())
    }) {
        return Err("A global shortcut must include Ctrl, Alt or Windows.".into());
    }
    let previous = session.registered_shortcut.clone();
    let next = preferences
        .shortcut_enabled
        .then(|| preferences.shortcut.clone());
    let enabled = app.autolaunch().is_enabled().map_err(|e| e.to_string())?;
    if previous != next {
        if next.is_some() {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|e| format!("Shortcut unavailable: {e}"))?;
        }
        if let Some(value) = &previous {
            let _ = app.global_shortcut().unregister(value.as_str());
        }
    }
    let save = (|| {
        if enabled != preferences.start_with_windows {
            if preferences.start_with_windows {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            }
            .map_err(|e| e.to_string())?;
        }
        preferences.write(&desktop.settings_path)
    })();
    if let Err(error) = save {
        if previous != next {
            if let Some(value) = &next {
                let _ = app.global_shortcut().unregister(value.as_str());
            }
            if let Some(value) = &previous {
                let _ = app.global_shortcut().register(value.as_str());
            }
        }
        if enabled {
            let _ = app.autolaunch().enable();
        } else {
            let _ = app.autolaunch().disable();
        }
        return Err(error);
    }
    session.prefs = preferences.clone();
    session.registered_shortcut = next;
    session.shortcut_error = None;
    drop(session);
    refresh_visibility(app);
    emit_state(app);
    Ok(preferences)
}
#[tauri::command]
fn desktop_finish_close(
    window: WebviewWindow,
    action: String,
    remember: bool,
) -> Result<(), String> {
    authorize(&window, true)?;
    if !["exit", "tray", "cancel"].contains(&action.as_str()) {
        return Err("Invalid closing action.".into());
    }
    if action == "cancel" {
        return Ok(());
    }
    let app = window.app_handle();
    if remember {
        let desktop = state(app);
        let mut session = desktop.session.lock().unwrap();
        let mut prefs = session.prefs.clone();
        prefs.close_behavior = if action == "tray" {
            CloseBehavior::Tray
        } else {
            CloseBehavior::Exit
        };
        prefs.write(&desktop.settings_path)?;
        session.prefs = prefs;
    }
    if action == "exit" {
        exit_app(app);
    } else {
        hide_main(app);
    }
    Ok(())
}
#[tauri::command]
fn desktop_set_dirty(window: WebviewWindow, dirty: bool) -> Result<(), String> {
    authorize(&window, false)?;
    let desktop = state(window.app_handle());
    let mut session = desktop.session.lock().unwrap();
    if dirty {
        session.dirty.insert(window.label().into());
    } else {
        session.dirty.remove(window.label());
    }
    Ok(())
}
#[tauri::command]
fn desktop_capture_done(window: WebviewWindow, saved: bool) -> Result<(), String> {
    authorize(&window, false)?;
    if window.label() != "capture" {
        return Err("Capture window only.".into());
    }
    if saved {
        state(window.app_handle())
            .session
            .lock()
            .unwrap()
            .dirty
            .remove("capture");
    }
    window.hide().map_err(|e| e.to_string())
}
#[tauri::command]
fn desktop_toggle_fullscreen(window: WebviewWindow) -> Result<(), String> {
    authorize(&window, true)?;
    window
        .set_fullscreen(!window.is_fullscreen().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn desktop_open_reference(window: WebviewWindow, url: String) -> Result<(), String> {
    authorize(&window, true)?;
    let target = url::Url::parse(&url).map_err(|_| "Invalid reference URL")?;
    if !["http", "https"].contains(&target.scheme())
        || !target.username().is_empty()
        || target.password().is_some()
        || url.len() > 8192
    {
        return Err("Only HTTP(S) references without embedded credentials can be opened.".into());
    }
    window
        .app_handle()
        .opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { if app.try_state::<Desktop>().is_some() { show_main(app); } }))
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(window_flags()).with_denylist(&["capture"]).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_autostart::Builder::new().app_name("Mneme").args(["--tray"]).build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| {
            if event.state() == ShortcutState::Pressed { if let Err(error) = capture(app) { report_error(app, error); } }
        }).build())
        .invoke_handler(tauri::generate_handler![desktop_state, desktop_choose_brain, desktop_preferences, desktop_save_preferences, desktop_finish_close, desktop_set_dirty, desktop_capture_done, desktop_toggle_fullscreen, desktop_open_reference])
        .setup(|app| {
            let directory = app.path().app_local_data_dir()?; std::fs::create_dir_all(&directory)?;
            // Keep canonical memory outside the directory the standard uninstaller may clear.
            let brains = app.path().local_data_dir()?.join("MnemeBrains");
            std::fs::create_dir_all(&brains)?;
            let settings_path = directory.join("desktop.json");
            let (prefs, error) = match Preferences::read(&settings_path) { Ok(prefs) => (prefs, None), Err(error) => (Preferences::default(), Some(error)) };
            let open = MenuItem::with_id(app, "open", "Open Mneme", true, None::<&str>)?;
            let capture_item = MenuItem::with_id(app, "capture", "Quick Capture", true, None::<&str>)?;
            let pause_item = CheckMenuItem::with_id(app, "pause", "Pause Background Processing", true, false, None::<&str>)?;
            let status_item = MenuItem::with_id(app, "status", "Status · choose a brain", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &capture_item, &PredefinedMenuItem::separator(app)?, &pause_item, &status_item, &PredefinedMenuItem::separator(app)?, &exit])?;
            let root = prefs.brain_root.clone();
            let initially_hidden = std::env::args().any(|arg| arg == "--tray") && root.is_some();
            app.manage(Desktop { session: Mutex::new(Session { prefs, backend: None, phase: if error.is_some() { "error" } else { "setup" }, error, shortcut_error: None, registered_shortcut: None, dirty: HashSet::new(), suspended: None, background: true }), settings_path, recommended: brains.join("Default"), switching: AtomicBool::new(false), exiting: AtomicBool::new(false), pause_item, status_item });
            let guarded = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html?desktop=setup".into()))
                .title("Mneme").inner_size(1280.0, 850.0).min_inner_size(900.0, 620.0)
                .center().theme(Some(tauri::Theme::Dark)).visible(!initially_hidden)
                .disable_drag_drop_handler().on_navigation(move |url| allowed_navigation(&guarded, url))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny).build()?;
            let observer = app.handle().clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => { api.prevent_close(); request_close(&observer, false); },
                WindowEvent::Resized(_) => {
                    let minimize = state(&observer).session.lock().unwrap().prefs.minimize_to_tray;
                    if minimize && observer.get_webview_window("main").is_some_and(|window| window.is_minimized().unwrap_or(false)) { hide_main(&observer); }
                    else { refresh_visibility(&observer); }
                }, _ => ()
            });
            TrayIconBuilder::with_id("mneme").icon(app.default_window_icon().unwrap().clone()).tooltip("Mneme — your local memory")
                .menu(&menu).show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) { show_main(tray.app_handle()); })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "capture" => if let Err(error) = capture(app) { report_error(app, error); },
                    "pause" => { let desktop = state(app); let mut session = desktop.session.lock().unwrap(); if let Some(backend) = session.backend.as_mut() { let _ = backend.send(json!({"type":"toggle-background"})); } },
                    "status" => { show_main(app); if let Some(window) = app.get_webview_window("main") { let _ = window.emit("desktop-status-requested", ()); } },
                    "exit" => request_close(app, true), _ => ()
                }).build(app)?;
            {
                let desktop = app.state::<Desktop>(); let mut session = desktop.session.lock().unwrap();
                if session.prefs.shortcut_enabled {
                    let shortcut = session.prefs.shortcut.clone();
                    match app.global_shortcut().register(shortcut.as_str()) {
                        Ok(()) => session.registered_shortcut = Some(shortcut),
                        Err(error) => session.shortcut_error = Some(format!("Global capture shortcut is unavailable. Choose another in Desktop settings. {error}"))
                    }
                }
            }
            if let Some(root) = root {
                let handle = app.handle().clone(); state(&handle).switching.store(true, Ordering::SeqCst);
                thread::spawn(move || {
                    let result = if root.join("database/brain.db").is_file() { start_brain(handle.clone(), root) } else { Err("The selected brain directory is unavailable. Reconnect its drive or open another existing brain.".into()) };
                    state(&handle).switching.store(false, Ordering::SeqCst);
                    if let Err(error) = result { report_error(&handle, error); }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!()).expect("Unable to initialize Mneme desktop")
        .run(|app, event| if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !state(app).exiting.load(Ordering::SeqCst) { api.prevent_exit(); request_close(app, true); }
        });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_origin_and_local_bootstrap_only() {
        assert!(same_origin(
            &"http://127.0.0.1:45000/".parse().unwrap(),
            "http://127.0.0.1:45000"
        ));
        for value in [
            "http://127.0.0.1:45001/",
            "http://localhost:45000/",
            "https://example.com/",
            "http://127.0.0.1.evil.test:45000/",
        ] {
            assert!(!same_origin(
                &value.parse().unwrap(),
                "http://127.0.0.1:45000"
            ));
            assert!(!bootstrap_url(&value.parse().unwrap()));
        }
        assert!(!bootstrap_url(
            &"http://tauri.localhost:1234/".parse().unwrap()
        ));
    }
}
