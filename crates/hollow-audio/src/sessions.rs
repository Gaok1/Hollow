//! Enumerating and controlling the per-application audio sessions Windows
//! already tracks — the same list the system volume mixer shows.
//!
//! This works on every Windows version Hollow supports, including build 19045,
//! and is what powers the mixer UI. Whether changing a session's volume affects
//! only the broadcast or also local playback depends on the capture mode; see
//! the crate docs.

use std::collections::HashMap;
use std::path::Path;

use windows::Win32::Foundation::{CloseHandle, MAX_PATH};
use windows::Win32::Media::Audio::{
    AudioSessionStateActive, AudioSessionStateExpired, IAudioSessionControl2,
    IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
    eConsole, eRender,
};
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::core::{Interface, PWSTR};

use crate::icon::icon_data_url;
use crate::types::{AppAudioSession, AudioError};

/// Handle to the default render endpoint's session manager.
///
/// Rebuilt when the default device changes; callers detect that by an
/// enumeration returning an error and constructing a fresh one.
pub struct SessionHost {
    manager: IAudioSessionManager2,
    /// Executable path -> icon data URL. Icon extraction hits the disk and the
    /// GDI, so it is done once per binary rather than per poll.
    icon_cache: HashMap<String, Option<String>>,
}

impl SessionHost {
    pub fn new() -> Result<Self, AudioError> {
        // SAFETY: COM is initialised by the caller's ComGuard on this thread.
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
        // SAFETY: enumerator is a live COM pointer.
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|_| AudioError::NoDevice)?;
        // SAFETY: activating a documented interface on a live endpoint.
        let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None)? };

        Ok(Self {
            manager,
            icon_cache: HashMap::new(),
        })
    }

    /// Snapshot every session on the endpoint.
    ///
    /// `broadcast_pids` marks which apps the user has included in the outgoing
    /// mix, so the UI gets that back without having to join two lists.
    pub fn enumerate(
        &mut self,
        broadcast_pids: &dyn Fn(u32) -> bool,
    ) -> Result<Vec<AppAudioSession>, AudioError> {
        // SAFETY: manager is live for the lifetime of self.
        let list = unsafe { self.manager.GetSessionEnumerator()? };
        // SAFETY: same.
        let count = unsafe { list.GetCount()? };

        let mut out = Vec::with_capacity(count as usize);
        for index in 0..count {
            // A session can expire between GetCount and GetSession; skip rather
            // than abort the whole enumeration.
            // SAFETY: index is within the count reported above.
            let Ok(control) = (unsafe { list.GetSession(index) }) else {
                continue;
            };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };

            // SAFETY: control2 is live.
            let state = unsafe { control.GetState() }.unwrap_or(AudioSessionStateExpired);
            if state == AudioSessionStateExpired {
                continue;
            }

            // SAFETY: live interface.
            let pid = unsafe { control2.GetProcessId() }.unwrap_or(0);
            // SAFETY: live interface; returns S_OK for the system sounds session.
            let is_system_sounds = unsafe { control2.IsSystemSoundsSession() }.is_ok();
            if pid == 0 && !is_system_sounds {
                continue;
            }

            let identifier = unsafe { control2.GetSessionIdentifier() }
                .ok()
                .and_then(|p| pwstr_to_string(p))
                .unwrap_or_else(|| format!("pid-{pid}"));

            let executable = process_path(pid);
            let display = unsafe { control.GetDisplayName() }
                .ok()
                .and_then(|p| pwstr_to_string(p))
                .filter(|s| !s.trim().is_empty());

            let name = if is_system_sounds {
                "System sounds".to_string()
            } else {
                display
                    .or_else(|| {
                        executable
                            .as_deref()
                            .and_then(|p| Path::new(p).file_stem())
                            .map(|s| s.to_string_lossy().into_owned())
                    })
                    .unwrap_or_else(|| format!("PID {pid}"))
            };

            let icon = match executable.as_deref() {
                Some(path) => self
                    .icon_cache
                    .entry(path.to_string())
                    .or_insert_with(|| icon_data_url(path).ok())
                    .clone(),
                None => None,
            };

            let (volume, muted) = match control2.cast::<ISimpleAudioVolume>() {
                // SAFETY: live interface.
                Ok(vol) => unsafe {
                    (
                        vol.GetMasterVolume().unwrap_or(1.0),
                        vol.GetMute().map(|m| m.as_bool()).unwrap_or(false),
                    )
                },
                Err(_) => (1.0, false),
            };

            let peak = match control2.cast::<IAudioMeterInformation>() {
                // SAFETY: live interface.
                Ok(meter) => unsafe { meter.GetPeakValue().unwrap_or(0.0) },
                Err(_) => 0.0,
            };

            out.push(AppAudioSession {
                id: identifier,
                pid,
                name,
                executable,
                icon,
                peak,
                volume,
                muted,
                active: state == AudioSessionStateActive,
                broadcast: broadcast_pids(pid),
            });
        }

        // By name, and only by name. Sorting the active ones to the top reads
        // well in a screenshot and badly in the hand: an app that falls quiet
        // for a moment takes its row with it, and a slider being dragged moves
        // out from under the pointer.
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    }

}

/// Full path of a process, or None when it has exited or we lack rights.
fn process_path(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    // SAFETY: a failed open returns Err and we bail.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;

    let mut buf = [0u16; MAX_PATH as usize];
    let mut len = buf.len() as u32;
    // SAFETY: buf and len describe the same buffer.
    let ok = unsafe {
        QueryFullProcessImageNameW(
            handle,
            windows::Win32::System::Threading::PROCESS_NAME_FORMAT(0),
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    };
    // SAFETY: handle came from OpenProcess and is not used after this.
    let _ = unsafe { CloseHandle(handle) };

    if ok.is_err() || len == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// Copies a COM-allocated wide string and frees it.
fn pwstr_to_string(p: PWSTR) -> Option<String> {
    if p.is_null() {
        return None;
    }
    // SAFETY: Windows guarantees a NUL-terminated string here.
    let s = unsafe { p.to_string() }.ok();
    // SAFETY: strings from these APIs are allocated with CoTaskMemAlloc and are
    // the caller's to free.
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(p.as_ptr() as *const _)) };
    s.filter(|s| !s.is_empty())
}
