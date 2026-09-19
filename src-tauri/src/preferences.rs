use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CloseBehavior {
    Ask,
    Exit,
    Tray,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Preferences {
    pub version: u32,
    pub brain_root: Option<PathBuf>,
    pub close_behavior: CloseBehavior,
    pub minimize_to_tray: bool,
    pub run_background_when_hidden: bool,
    pub start_with_windows: bool,
    pub shortcut_enabled: bool,
    pub shortcut: String,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: 1,
            brain_root: None,
            close_behavior: CloseBehavior::Ask,
            minimize_to_tray: false,
            run_background_when_hidden: false,
            start_with_windows: false,
            shortcut_enabled: true,
            shortcut: "Ctrl+Alt+Space".into(),
        }
    }
}
impl Preferences {
    pub fn read(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        if bytes.len() > 16384 {
            return Err("Desktop preferences exceed the size limit.".into());
        }
        let result: Self = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Cannot read desktop preferences: {e}"))?;
        result.validate()?;
        Ok(result)
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported desktop preferences version.".into());
        }
        if self.shortcut.is_empty() || self.shortcut.len() > 80 {
            return Err("Enter a valid shortcut.".into());
        }
        if let Some(path) = &self.brain_root {
            if !path.is_absolute() {
                return Err("The brain directory must be absolute.".into());
            }
        }
        Ok(())
    }
    pub fn write(&self, path: &Path) -> Result<(), String> {
        self.validate()?;
        fs::create_dir_all(path.parent().ok_or("Missing settings directory")?)
            .map_err(|e| e.to_string())?;
        let temporary = path.with_extension("json.tmp");
        let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(temporary, path).map_err(|e| e.to_string())
    }
}

// Windows paths remain case-insensitive after resolving junctions. Compare
// components so an adjacent directory such as MnemeBrains is not rejected.
pub fn is_within(path: &Path, directory: &Path) -> bool {
    let mut child = dunce::simplified(path).components();
    dunce::simplified(directory).components().all(|parent| {
        child.next().is_some_and(|part| {
            if cfg!(windows) {
                part.as_os_str().to_string_lossy().to_lowercase()
                    == parent.as_os_str().to_string_lossy().to_lowercase()
            } else {
                part == parent
            }
        })
    })
}

pub fn validate_brain(path: &Path, install: &Path, existing: bool) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Choose an absolute folder.".into());
    }
    // Resolve junctions before checking the installation boundary.
    let resolved = if path.exists() {
        path.canonicalize()
    } else {
        path.parent()
            .ok_or("Choose a folder below an existing directory.")?
            .canonicalize()
            .map(|parent| parent.join(path.file_name().unwrap_or_default()))
    }
    .map_err(|e| e.to_string())?;
    let install = install.canonicalize().map_err(|e| e.to_string())?;
    if is_within(&resolved, &install) {
        return Err("Choose a brain directory outside the application installation.".into());
    }
    if existing {
        if !resolved.join("database/brain.db").is_file() {
            return Err("This folder does not contain a Mneme brain (database/brain.db).".into());
        }
    } else if resolved.exists()
        && fs::read_dir(&resolved)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
    {
        return Err(
            "Choose an empty folder, or use Open existing brain. Nothing has been moved.".into(),
        );
    }
    Ok(dunce::simplified(&resolved).to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn windows_directory_boundary_ignores_case_but_not_components() {
        let install = Path::new(r"C:\Users\Test\Mneme");
        assert!(is_within(
            Path::new(r"\\?\C:\users\TEST\mneme\brain"),
            install
        ));
        assert!(is_within(install, install));
        assert!(!is_within(
            Path::new(r"C:\Users\Test\MnemeBrains\Default"),
            install
        ));
        assert!(!is_within(Path::new(r"C:\Users\Test"), install));
    }
    #[test]
    fn preferences_reject_versions_and_relative_paths() {
        let mut prefs = Preferences::default();
        prefs.version = 2;
        assert!(prefs.validate().is_err());
        prefs.version = 1;
        prefs.brain_root = Some("relative".into());
        assert!(prefs.validate().is_err());
        assert!(serde_json::from_str::<Preferences>(r#"{"arbitrary_shell":"bad"}"#).is_err());
    }
    #[test]
    fn preference_replacement_is_atomic_and_readable() {
        let root = std::env::temp_dir().join(format!("mneme-prefs-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("desktop.json");
        let mut prefs = Preferences::default();
        prefs.write(&path).unwrap();
        prefs.close_behavior = CloseBehavior::Tray;
        prefs.write(&path).unwrap();
        assert_eq!(
            Preferences::read(&path).unwrap().close_behavior,
            CloseBehavior::Tray
        );
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
