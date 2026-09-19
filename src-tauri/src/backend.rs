use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(windows)]
fn own_process(child: &Child) -> Result<Job, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::*;
    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let job = Job(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(job)
    }
}

pub struct Backend {
    child: Child,
    input: ChildStdin,
    #[cfg(windows)]
    _job: Job,
    pub origin: String,
    pub token: String,
    pub root: PathBuf,
}
impl Backend {
    pub fn start(app: &tauri::AppHandle, root: &Path) -> Result<(Self, Receiver<Value>), String> {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut runtime = executable
            .parent()
            .ok_or("Missing application directory")?
            .join("mneme-core.exe");
        let mut resources = app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("core");
        if cfg!(debug_assertions) {
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            if !runtime.exists() {
                runtime = source.join("binaries/mneme-core-x86_64-pc-windows-msvc.exe");
            }
            if !resources.join("dist/server/desktop.js").exists() {
                resources = source.join("resources/core");
            }
        }
        if !runtime.is_file() || !resources.join("dist/server/desktop.js").is_file() {
            return Err("The bundled memory engine is missing. Reinstall Mneme; your brain is stored separately.".into());
        }
        Self::start_paths(runtime, resources, root)
    }
    fn start_paths(
        runtime: PathBuf,
        resources: PathBuf,
        root: &Path,
    ) -> Result<(Self, Receiver<Value>), String> {
        // Windows extended paths cannot contain forward separators. Tauri can return
        // an extended resource path; normalize it before crossing the Node boundary.
        let resources = dunce::canonicalize(resources).map_err(|e| e.to_string())?;
        let entry = resources.join("dist").join("server").join("desktop.js");
        let mut command = Command::new(runtime);
        command
            .arg(entry)
            .arg(dunce::simplified(root))
            .current_dir(&resources)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start memory engine: {e}"))?;
        #[cfg(windows)]
        let job = match own_process(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let input = child.stdin.take().ok_or("Missing core control pipe")?;
        let output = child.stdout.take().ok_or("Missing core readiness pipe")?;
        let errors = child.stderr.take().ok_or("Missing core diagnostic pipe")?;
        // Only retain bounded process-startup diagnostics, in memory. Never log stdout/session keys.
        let diagnostics = Arc::new(Mutex::new(Vec::<u8>::new()));
        let startup_errors = diagnostics.clone();
        thread::spawn(move || {
            let mut errors = errors;
            let mut bytes = [0; 1024];
            while let Ok(count) = errors.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                let mut buffer = startup_errors.lock().unwrap();
                if buffer.len() < 4096 {
                    let available = (4096 - buffer.len()).min(count);
                    buffer.extend_from_slice(&bytes[..available]);
                }
            }
        });
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                match reader.by_ref().take(65537).read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if line.len() > 65536 => break,
                    Ok(_) => {
                        if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                            if sender.send(value).is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });
        let ready = receiver.recv_timeout(Duration::from_secs(60));
        let parse = || -> Result<(String, String, PathBuf), String> {
            let value = ready.map_err(|error| {
                let detail = String::from_utf8_lossy(&diagnostics.lock().unwrap()).to_string();
                match error {
                    mpsc::RecvTimeoutError::Timeout => {
                        "Memory engine did not become ready within 60 seconds.".to_string()
                    }
                    mpsc::RecvTimeoutError::Disconnected => format!(
                        "Memory engine could not start. {}",
                        detail.chars().take(1800).collect::<String>()
                    ),
                }
            })?;
            if value["type"] != "ready" {
                return Err(value["message"]
                    .as_str()
                    .unwrap_or("Memory engine could not start.")
                    .into());
            }
            let origin = value["origin"]
                .as_str()
                .ok_or("Missing engine origin")?
                .to_owned();
            let url = url::Url::parse(&origin).map_err(|e| e.to_string())?;
            if url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || url.port().is_none()
                || url.path() != "/"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("Invalid engine origin".into());
            }
            let token = value["token"]
                .as_str()
                .ok_or("Missing session key")?
                .to_owned();
            if token.len() != 64 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("Invalid session key".into());
            }
            Ok((
                origin,
                token,
                PathBuf::from(value["root"].as_str().ok_or("Missing brain root")?),
            ))
        };
        match parse() {
            Ok((origin, token, root)) => Ok((
                Self {
                    child,
                    input,
                    #[cfg(windows)]
                    _job: job,
                    origin,
                    token,
                    root,
                },
                receiver,
            )),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(error)
            }
        }
    }
    pub fn pid(&self) -> u32 {
        self.child.id()
    }
    pub fn send(&mut self, value: Value) -> Result<(), String> {
        writeln!(self.input, "{value}")
            .and_then(|_| self.input.flush())
            .map_err(|e| e.to_string())
    }
    pub fn shutdown(mut self) {
        let _ = self.send(json!({"type":"shutdown"}));
        let deadline = Instant::now() + Duration::from_secs(70);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                _ => thread::sleep(Duration::from_millis(50)),
            }
        }
        // Bounded fallback: canonical WAL/outbox recovery runs on the next start.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_bundled_core_starts_from_canonical_windows_paths_and_shuts_down() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let runtime = source.join("binaries/mneme-core-x86_64-pc-windows-msvc.exe");
        let resources = source.join("resources/core").canonicalize().unwrap();
        let root = source
            .parent()
            .unwrap()
            .join(".test-brains")
            .join(format!("rust desktop {}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let (mut backend, events) =
            Backend::start_paths(runtime, resources, &root).expect("real bundled core startup");
        assert!(backend.origin.starts_with("http://127.0.0.1:"));
        backend
            .send(json!({"type":"visibility", "suspended":true}))
            .unwrap();
        loop {
            let event = events.recv_timeout(Duration::from_secs(5)).unwrap();
            if event["type"] == "status" && event["suspended"] == true {
                break;
            }
        }
        backend.shutdown();
        assert!(root.join("database/brain.db").is_file());
        assert!(!root.join("database/owner.lock").exists());
        // This test creates and owns this exact directory below .test-brains.
        let boundary = source
            .parent()
            .unwrap()
            .join(".test-brains")
            .canonicalize()
            .unwrap();
        assert!(root.starts_with(boundary));
        std::fs::remove_dir_all(root).unwrap();
    }
}
