//! COM lifetime and OS version helpers.

use std::sync::OnceLock;

use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::Registry::{
    HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW,
};
use windows::core::w;

/// Initialises COM for the calling thread and uninitialises it on drop.
///
/// WASAPI requires COM, and every thread that touches an audio interface needs
/// its own initialisation.
pub struct ComGuard {
    initialised: bool,
}

impl ComGuard {
    pub fn new() -> Self {
        // SAFETY: matched by CoUninitialize in Drop. RPC_E_CHANGED_MODE means
        // the thread already joined a different apartment, which is fine — we
        // just must not uninitialise someone else's.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        Self {
            initialised: hr.is_ok(),
        }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.initialised {
            // SAFETY: paired with the CoInitializeEx above on this same thread.
            unsafe { CoUninitialize() };
        }
    }
}

impl Default for ComGuard {
    fn default() -> Self {
        Self::new()
    }
}

static BUILD_NUMBER: OnceLock<u32> = OnceLock::new();

/// The real Windows build number.
///
/// Read from the registry rather than `GetVersionEx`, which reports a shimmed
/// value for processes without a matching compatibility manifest and would tell
/// us 19045 is something else entirely.
pub fn windows_build() -> u32 {
    *BUILD_NUMBER.get_or_init(|| {
        read_current_version(w!("CurrentBuildNumber"))
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0)
    })
}

fn read_current_version(name: windows::core::PCWSTR) -> Option<String> {
    let subkey = w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let mut size: u32 = 0;

    // First call sizes the buffer.
    // SAFETY: passing null data with a valid size pointer is the documented way
    // to query the required length.
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey,
            name,
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        )
    };
    if rc.is_err() || size == 0 {
        return None;
    }

    let mut buf = vec![0u16; (size as usize).div_ceil(2)];
    // SAFETY: buf is sized from the query above; size is updated in place.
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey,
            name,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if rc.is_err() {
        return None;
    }

    let chars = (size as usize / 2).min(buf.len());
    let end = buf[..chars]
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(chars);
    Some(String::from_utf16_lossy(&buf[..end]))
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_a_plausible_build() {
        // Any supported Windows is well past Vista; a zero means the registry
        // read silently failed.
        assert!(super::windows_build() > 7000, "got {}", super::windows_build());
    }
}
