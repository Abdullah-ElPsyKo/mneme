fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_state",
            "desktop_choose_brain",
            "desktop_preferences",
            "desktop_save_preferences",
            "desktop_finish_close",
            "desktop_set_dirty",
            "desktop_capture_done",
            "desktop_toggle_fullscreen",
            "desktop_open_reference",
        ]),
    ))
    .expect("Tauri build configuration failed");
}
