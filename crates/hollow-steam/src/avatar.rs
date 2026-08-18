//! Steam hands out avatars as a raw RGBA buffer. The UI wants something it can
//! drop into an `<img src>`, so encode to PNG and wrap in a data URL.

use anyhow::{Result, bail};
use base64::Engine;

pub fn rgba_to_data_url(rgba: &[u8], width: u32, height: u32) -> Result<String> {
    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() != expected {
        bail!(
            "avatar buffer is {} bytes, expected {expected} for {width}x{height} RGBA",
            rgba.len()
        );
    }

    let mut png = Vec::with_capacity(expected / 3);
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(rgba)?;
    }

    let mut url = String::from("data:image/png;base64,");
    base64::engine::general_purpose::STANDARD.encode_string(&png, &mut url);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_solid_square() {
        let rgba = vec![0x40u8; 8 * 8 * 4];
        let url = rgba_to_data_url(&rgba, 8, 8).expect("encode");
        assert!(url.starts_with("data:image/png;base64,iVBOR"));
    }

    #[test]
    fn rejects_a_mismatched_buffer() {
        assert!(rgba_to_data_url(&[0u8; 10], 8, 8).is_err());
    }
}
