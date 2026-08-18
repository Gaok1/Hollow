//! WASAPI loopback capture.
//!
//! Two strategies live here behind one [`LoopbackStream`] type:
//!
//! * [`LoopbackStream::system`] captures the whole render endpoint. Works
//!   everywhere. Cannot separate applications.
//! * [`LoopbackStream::process`] captures one process tree. Requires build
//!   20348+; this is what makes muting an app affect only the broadcast.
//!
//! Both deliver interleaved f32 stereo at [`crate::SAMPLE_RATE`].
//!
//! Capture is polled on a 5ms cadence rather than driven by
//! `AUDCLNT_STREAMFLAGS_EVENTCALLBACK`. Loopback streams famously stop
//! signalling their event when the endpoint goes silent, which would stall the
//! mixer exactly when a user mutes everything; polling costs a negligible amount
//! and never wedges.

use std::time::Duration;

use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, ActivateAudioInterfaceAsync,
    IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    IMMDeviceEnumerator, MMDeviceEnumerator, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, eConsole, eRender,
};
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, CoTaskMemFree};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::core::{ComObject, HRESULT, Interface, PROPVARIANT, implement};

use crate::types::AudioError;
use crate::{CHANNELS, SAMPLE_RATE};

/// How often to drain the capture buffer.
pub const POLL: Duration = Duration::from_millis(5);

/// A running loopback capture. Dropping it stops the stream.
pub struct LoopbackStream {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    /// Source channel count, needed to downmix or upmix to stereo.
    src_channels: u16,
    /// Source rate; resampled to 48kHz when it differs.
    src_rate: u32,
    /// Carried between reads so linear interpolation is continuous.
    resample_pos: f64,
    tail: Vec<f32>,
    /// Label for logs.
    pub label: String,
}

// SAFETY: the WASAPI interfaces are used from exactly one thread — the audio
// thread that constructed them. LoopbackStream is moved onto that thread once
// and never shared.
unsafe impl Send for LoopbackStream {}

impl LoopbackStream {
    /// Capture the entire default render endpoint.
    pub fn system() -> Result<Self, AudioError> {
        // SAFETY: COM initialised by the caller's ComGuard.
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
        // SAFETY: live enumerator.
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|_| AudioError::NoDevice)?;
        // SAFETY: live device.
        let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None)? };

        // SAFETY: returns a CoTaskMem-allocated format we free below.
        let format_ptr = unsafe { client.GetMixFormat()? };
        // SAFETY: format_ptr is non-null on success.
        let (channels, rate) = unsafe { ((*format_ptr).nChannels, (*format_ptr).nSamplesPerSec) };

        // SAFETY: initialising with the exact format the device reported.
        let init = unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                buffer_duration_100ns(),
                0,
                format_ptr,
                None,
            )
        };
        // SAFETY: format_ptr came from GetMixFormat and is ours to free.
        unsafe { CoTaskMemFree(Some(format_ptr.cast())) };
        init?;

        // SAFETY: live client, initialised above.
        let capture: IAudioCaptureClient = unsafe { client.GetService()? };
        // SAFETY: same.
        unsafe { client.Start()? };

        Ok(Self {
            client,
            capture,
            src_channels: channels,
            src_rate: rate,
            resample_pos: 0.0,
            tail: Vec::new(),
            label: "System audio".into(),
        })
    }

    /// Capture one process and its children.
    ///
    /// Requires Windows build 20348 or later; earlier builds fail activation.
    /// Untested on build 19045, which cannot run this path at all.
    pub fn process(pid: u32, label: String) -> Result<Self, AudioError> {
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };

        // The activation parameters travel as a VT_BLOB PROPVARIANT. Since
        // windows-rs 0.56 `PROPVARIANT` is opaque with no way to build a BLOB
        // variant through the safe API, so lay the bytes out by hand.
        let prop = PropVariantBlob::new(
            &mut params as *mut _ as *mut u8,
            std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        );

        // The handler owns the event and closes it on drop. We keep a Copy of
        // the handle purely to wait on, and never close it here: if activation
        // times out the callback can still fire afterwards, and it must find a
        // live handle. COM holds a reference until then, which keeps the handler
        // — and therefore the event — alive exactly as long as needed.
        // SAFETY: auto-reset event, initially unsignalled.
        let done = unsafe { CreateEventW(None, false, false, None)? };
        let handler = ComObject::new(ActivationHandler { done });
        let handler_iface = handler.to_interface::<IActivateAudioInterfaceCompletionHandler>();

        let activation = (|| -> Result<IAudioClient, AudioError> {
            // SAFETY: the virtual device id is the documented constant; `prop`
            // and `params` both outlive the call, and `handler` outlives the
            // operation it is handed to.
            let operation: IActivateAudioInterfaceAsyncOperation = unsafe {
                ActivateAudioInterfaceAsync(
                    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                    &IAudioClient::IID,
                    Some(prop.as_propvariant()),
                    &handler_iface,
                )?
            };

            // SAFETY: live event handle owned by this frame.
            let rc = unsafe { WaitForSingleObject(done, ACTIVATION_TIMEOUT_MS) };
            if rc != WAIT_OBJECT_0 {
                return Err(AudioError::Other(
                    "timed out waiting for process loopback activation".into(),
                ));
            }

            let mut hr = HRESULT(0);
            let mut unknown: Option<windows::core::IUnknown> = None;
            // SAFETY: both out-params are valid; the operation completed above.
            unsafe { operation.GetActivateResult(&mut hr, &mut unknown)? };
            hr.ok()?;
            unknown
                .ok_or_else(|| AudioError::Other("process loopback returned no client".into()))?
                .cast::<IAudioClient>()
                .map_err(AudioError::from)
        })();

        let client = activation?;
        drop(handler);

        // Process loopback does not implement GetMixFormat; the caller states
        // the format it wants and WASAPI converts.
        let mut format = float_format(CHANNELS, SAMPLE_RATE);

        // SAFETY: format is a well-formed WAVEFORMATEX living past the call.
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                buffer_duration_100ns(),
                0,
                &mut format,
                None,
            )?
        };

        // SAFETY: live, initialised client.
        let capture: IAudioCaptureClient = unsafe { client.GetService()? };
        // SAFETY: same.
        unsafe { client.Start()? };

        Ok(Self {
            client,
            capture,
            src_channels: CHANNELS,
            src_rate: SAMPLE_RATE,
            resample_pos: 0.0,
            tail: Vec::new(),
            label,
        })
    }

    /// Drain everything currently buffered, appending interleaved stereo f32 at
    /// 48kHz to `out`. Returns the peak absolute sample seen this call.
    pub fn drain(&mut self, out: &mut Vec<f32>) -> Result<f32, AudioError> {
        let mut peak = 0.0f32;

        loop {
            // SAFETY: live capture client.
            let packet = unsafe { self.capture.GetNextPacketSize()? };
            if packet == 0 {
                break;
            }

            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames: u32 = 0;
            let mut flags: u32 = 0;
            // SAFETY: all out-params are valid; buffer released below.
            unsafe {
                self.capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)?
            };

            if frames > 0 && !data.is_null() {
                const SILENT: u32 =
                    windows::Win32::Media::Audio::AUDCLNT_BUFFERFLAGS_SILENT.0 as u32;
                let src_len = frames as usize * self.src_channels as usize;

                if flags & SILENT != 0 {
                    // Windows may hand back an uninitialised buffer flagged
                    // silent; synthesising zeroes is both correct and cheaper.
                    self.tail.extend(std::iter::repeat_n(0.0, src_len));
                } else {
                    // SAFETY: the endpoint is float format, and WASAPI
                    // guarantees frames*channels samples are readable.
                    let samples =
                        unsafe { std::slice::from_raw_parts(data.cast::<f32>(), src_len) };
                    for &s in samples {
                        peak = peak.max(s.abs());
                    }
                    self.tail.extend_from_slice(samples);
                }
            }

            // SAFETY: releasing exactly the frame count we were given.
            unsafe { self.capture.ReleaseBuffer(frames)? };
        }

        if !self.tail.is_empty() {
            let taken = std::mem::take(&mut self.tail);
            self.convert_into(&taken, out);
        }

        Ok(peak)
    }

    /// Downmix/upmix to stereo and resample to 48kHz.
    ///
    /// Linear interpolation is enough here: the common case is a 48kHz endpoint
    /// where the ratio is exactly 1.0 and this degenerates to a copy. It only
    /// engages on 44.1kHz devices, where the artefacts sit far above the range
    /// Opus preserves anyway.
    fn convert_into(&mut self, src: &[f32], out: &mut Vec<f32>) {
        let ch = self.src_channels.max(1) as usize;
        let frames = src.len() / ch;
        if frames == 0 {
            return;
        }

        let to_stereo = |frame: usize| -> (f32, f32) {
            let base = frame * ch;
            match ch {
                1 => (src[base], src[base]),
                _ => (src[base], src[base + 1]),
            }
        };

        if self.src_rate == SAMPLE_RATE {
            out.reserve(frames * 2);
            for f in 0..frames {
                let (l, r) = to_stereo(f);
                out.push(l);
                out.push(r);
            }
            return;
        }

        let ratio = self.src_rate as f64 / SAMPLE_RATE as f64;
        let mut pos = self.resample_pos;
        while pos < frames as f64 - 1.0 {
            let i = pos.floor() as usize;
            let frac = (pos - i as f64) as f32;
            let (l0, r0) = to_stereo(i);
            let (l1, r1) = to_stereo(i + 1);
            out.push(l0 + (l1 - l0) * frac);
            out.push(r0 + (r1 - r0) * frac);
            pos += ratio;
        }
        // Carry the fractional remainder so the next block joins seamlessly.
        self.resample_pos = pos - frames as f64;
    }
}

impl Drop for LoopbackStream {
    fn drop(&mut self) {
        // SAFETY: live client; stopping an already-stopped client is harmless.
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

/// 200ms of slack. Loopback capture only needs enough headroom that a scheduling
/// hiccup does not drop packets.
fn buffer_duration_100ns() -> i64 {
    200 * 10_000
}

/// `WAVE_FORMAT_IEEE_FLOAT` from mmreg.h. The windows crate does not re-export
/// it under `Win32::Media::Audio`, and it has been 3 since 1996.
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

fn float_format(channels: u16, rate: u32) -> WAVEFORMATEX {
    let bits = 32u16;
    let block_align = channels * bits / 8;
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
        nChannels: channels,
        nSamplesPerSec: rate,
        nAvgBytesPerSec: rate * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: bits,
        cbSize: 0,
    }
}

/// Give up on activation after this long. Bounded rather than `INFINITE` so a
/// wedged audio service cannot hang the whole engine thread.
const ACTIVATION_TIMEOUT_MS: u32 = 5_000;

/// `ActivateAudioInterfaceAsync` is asynchronous and reports completion through
/// this COM callback. We block on an event rather than plumbing async through
/// the audio thread, which has nothing else to do until the stream exists.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    done: HANDLE,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        // SAFETY: the handle stays live for as long as this object does, and
        // this object outlives every call COM can make on it.
        unsafe {
            let _ = windows::Win32::System::Threading::SetEvent(self.this.done);
        }
        Ok(())
    }
}

impl Drop for ActivationHandler {
    fn drop(&mut self) {
        // SAFETY: handle came from CreateEventW and is closed exactly once.
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.done);
        }
    }
}

/// A `PROPVARIANT` holding a `VT_BLOB`, laid out by hand.
///
/// `windows::core::PROPVARIANT` is opaque and offers no constructor for BLOB
/// variants, so this mirrors the C layout: a four-`u16` header followed by the
/// 16-byte union, which for `VT_BLOB` is `{ u32 cbSize; void* pBlobData; }`.
/// Total 24 bytes on x86-64, matching `PROPVARIANT`.
#[repr(C)]
struct PropVariantBlob {
    vt: u16,
    reserved1: u16,
    reserved2: u16,
    reserved3: u16,
    cb_size: u32,
    /// Explicit, because the pointer that follows is 8-byte aligned.
    _padding: u32,
    blob_data: *mut u8,
}

impl PropVariantBlob {
    /// `VT_BLOB` from wtypes.h.
    const VT_BLOB: u16 = 65;

    fn new(data: *mut u8, len: u32) -> Self {
        Self {
            vt: Self::VT_BLOB,
            reserved1: 0,
            reserved2: 0,
            reserved3: 0,
            cb_size: len,
            _padding: 0,
            blob_data: data,
        }
    }

    /// Reinterpret as the opaque `PROPVARIANT` the API expects.
    fn as_propvariant(&self) -> *const PROPVARIANT {
        // Guard the assumption the layout rests on. A mismatch here would mean
        // handing the audio service a malformed variant.
        const _: () = assert!(
            std::mem::size_of::<PropVariantBlob>() == std::mem::size_of::<PROPVARIANT>(),
            "PropVariantBlob must match PROPVARIANT's layout"
        );
        (self as *const Self).cast()
    }
}
