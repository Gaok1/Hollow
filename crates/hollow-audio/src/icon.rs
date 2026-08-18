//! Pulls an application's icon out of its executable so the mixer can show it.
//!
//! A volume mixer that lists bare process names reads like a debugging tool.
//! Icons are what make it feel like part of the system.

use anyhow::{Result, anyhow};
use base64::Engine;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits,
    GetObjectW, ReleaseDC,
};
use windows::Win32::UI::Shell::ExtractIconExW;
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};
use windows::core::HSTRING;

/// Extract the first icon from `exe_path` as a `data:image/png;base64,...` URL.
pub fn icon_data_url(exe_path: &str) -> Result<String> {
    let wide = HSTRING::from(exe_path);
    let mut large: [HICON; 1] = [HICON::default()];
    let mut small: [HICON; 1] = [HICON::default()];

    // SAFETY: the arrays are sized to the requested icon count of 1.
    let extracted = unsafe {
        ExtractIconExW(
            &wide,
            0,
            Some(large.as_mut_ptr()),
            Some(small.as_mut_ptr()),
            1,
        )
    };
    if extracted == 0 || large[0].is_invalid() {
        // Prefer the large icon; fall back to the small one.
        if small[0].is_invalid() {
            return Err(anyhow!("no icon in {exe_path}"));
        }
    }

    let (chosen, other) = if large[0].is_invalid() {
        (small[0], large[0])
    } else {
        (large[0], small[0])
    };

    let result = hicon_to_png(chosen);

    // SAFETY: both handles came from ExtractIconExW and are ours to destroy.
    unsafe {
        if !chosen.is_invalid() {
            let _ = DestroyIcon(chosen);
        }
        if !other.is_invalid() {
            let _ = DestroyIcon(other);
        }
    }

    let png = result?;
    let mut url = String::from("data:image/png;base64,");
    base64::engine::general_purpose::STANDARD.encode_string(&png, &mut url);
    Ok(url)
}

fn hicon_to_png(icon: HICON) -> Result<Vec<u8>> {
    let mut info = ICONINFO::default();
    // SAFETY: info is a valid out-param.
    unsafe { GetIconInfo(icon, &mut info) }?;

    // GetIconInfo hands us two bitmaps we own and must free on every path.
    let color = info.hbmColor;
    let mask = info.hbmMask;
    let cleanup = || {
        // SAFETY: both handles came from GetIconInfo.
        unsafe {
            if !color.is_invalid() {
                let _ = DeleteObject(color);
            }
            if !mask.is_invalid() {
                let _ = DeleteObject(mask);
            }
        }
    };

    if color.is_invalid() {
        cleanup();
        return Err(anyhow!("icon has no colour bitmap"));
    }

    let mut bmp = BITMAP::default();
    // SAFETY: bmp matches the size we declare.
    let wrote = unsafe {
        GetObjectW(
            color,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        )
    };
    if wrote == 0 {
        cleanup();
        return Err(anyhow!("GetObjectW failed on icon bitmap"));
    }

    let width = bmp.bmWidth;
    let height = bmp.bmHeight;
    if width <= 0 || height <= 0 || width > 512 || height > 512 {
        cleanup();
        return Err(anyhow!("implausible icon size {width}x{height}"));
    }

    let mut header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        // Negative height requests a top-down DIB, which matches PNG's row order.
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut bmi = BITMAPINFO {
        bmiHeader: header,
        ..Default::default()
    };

    let pixel_count = (width * height) as usize;
    let mut bgra = vec![0u8; pixel_count * 4];

    // SAFETY: GetDC(None) returns the screen DC; released below.
    let hdc = unsafe { GetDC(HWND::default()) };
    // SAFETY: buffer is sized width*height*4 to match the header we pass.
    let scanlines = unsafe {
        GetDIBits(
            hdc,
            color,
            0,
            height as u32,
            Some(bgra.as_mut_ptr().cast()),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    // SAFETY: hdc came from GetDC with the same HWND.
    unsafe { ReleaseDC(HWND::default(), hdc) };
    header = bmi.bmiHeader;
    let _ = header;

    if scanlines == 0 {
        cleanup();
        return Err(anyhow!("GetDIBits returned no scanlines"));
    }

    // Windows gives BGRA; PNG wants RGBA.
    let mut rgba = vec![0u8; pixel_count * 4];
    let mut any_alpha = false;
    for i in 0..pixel_count {
        let b = bgra[i * 4];
        let g = bgra[i * 4 + 1];
        let r = bgra[i * 4 + 2];
        let a = bgra[i * 4 + 3];
        any_alpha |= a != 0;
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = a;
    }

    // Older icons carry no alpha channel and rely on the AND mask instead.
    // Without this, such icons come out fully transparent.
    if !any_alpha {
        for px in rgba.chunks_exact_mut(4) {
            px[3] = 255;
        }
    }

    cleanup();

    let mut png = Vec::with_capacity(pixel_count);
    {
        let mut encoder = png::Encoder::new(&mut png, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(&rgba)?;
    }
    Ok(png)
}
