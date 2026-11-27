use super::*;

pub(super) const STRIP_ERROR: &str = "无法清除图片元数据，未保存原图";

pub(super) fn strip(raw: &[u8]) -> Option<Vec<u8>> {
    match image::guess_format(raw).ok()? {
        ImageFormat::Jpeg => jpeg(raw),
        ImageFormat::Png => png(raw),
        ImageFormat::WebP => webp(raw),
        ImageFormat::Gif => gif(raw),
        _ => None,
    }
}

fn take<'a>(input: &mut &'a [u8], n: usize) -> Option<&'a [u8]> {
    let (part, rest) = input.split_at_checked(n)?;
    *input = rest;
    Some(part)
}

fn jpeg(mut input: &[u8]) -> Option<Vec<u8>> {
    let mut out = take(&mut input, 2)?.to_vec();
    loop {
        let segment = input;
        if take(&mut input, 1)? != [0xff] {
            return None;
        }
        while input.first() == Some(&0xff) {
            input = &input[1..];
        }
        let marker = take(&mut input, 1)?[0];
        match marker {
            0x01 => {
                out.extend_from_slice(&segment[..segment.len() - input.len()]);
                continue;
            }
            0x00 | 0xd0..=0xd9 => return None,
            _ => (),
        }
        let length = u16::from_be_bytes(take(&mut input, 2)?.try_into().ok()?) as usize;
        let payload = take(&mut input, length.checked_sub(2)?)?;
        if marker == 0xda {
            if !input.windows(2).any(|pair| pair == [0xff, 0xd9]) {
                return None;
            }
            out.extend_from_slice(segment);
            return Some(out);
        }
        if !matches!(marker, 0xe1 | 0xed | 0xfe)
            && (marker != 0xe2 || payload.starts_with(b"ICC_PROFILE\0"))
        {
            out.extend_from_slice(&segment[..segment.len() - input.len()]);
        }
    }
}

fn png(mut input: &[u8]) -> Option<Vec<u8>> {
    let mut out = take(&mut input, 8)?.to_vec();
    if input.get(4..8)? != b"IHDR" {
        return None;
    }
    loop {
        let chunk = input;
        let size = u32::from_be_bytes(take(&mut input, 4)?.try_into().ok()?) as usize;
        let kind = take(&mut input, 4)?;
        take(&mut input, size)?;
        let data_end = chunk.len() - input.len();
        let crc = u32::from_be_bytes(take(&mut input, 4)?.try_into().ok()?);
        let mut checksum = flate2::Crc::new();
        checksum.update(&chunk[4..data_end]);
        if crc != checksum.sum() {
            return None;
        }
        if !matches!(kind, b"eXIf" | b"tEXt" | b"zTXt" | b"iTXt" | b"tIME") {
            out.extend_from_slice(&chunk[..data_end + 4]);
        }
        if kind == b"IEND" {
            return (size == 0 && input.is_empty()).then_some(out);
        }
    }
}

fn webp(mut input: &[u8]) -> Option<Vec<u8>> {
    let header = take(&mut input, 12)?;
    let size = u32::from_le_bytes(header[4..8].try_into().ok()?) as usize;
    if &header[..4] != b"RIFF" || &header[8..] != b"WEBP" || size != input.len() + 4 {
        return None;
    }
    let mut out = header.to_vec();
    while !input.is_empty() {
        let chunk = input;
        let kind = take(&mut input, 4)?;
        let size = u32::from_le_bytes(take(&mut input, 4)?.try_into().ok()?) as usize;
        take(&mut input, size)?;
        take(&mut input, size & 1)?;
        if matches!(kind, b"EXIF" | b"XMP ") {
            continue;
        }
        let start = out.len();
        out.extend_from_slice(&chunk[..chunk.len() - input.len()]);
        if kind == b"VP8X" {
            if size != 10 {
                return None;
            }
            out[start + 8] &= !(0x08 | 0x04);
        }
    }
    let size = u32::try_from(out.len() - 8).ok()?;
    out[4..8].copy_from_slice(&size.to_le_bytes());
    Some(out)
}

fn gif(mut input: &[u8]) -> Option<Vec<u8>> {
    fn palette_size(flags: u8) -> usize {
        if flags & 0x80 == 0 {
            0
        } else {
            6 << (flags & 7)
        }
    }
    let header = take(&mut input, 13)?;
    let mut out = header.to_vec();
    out.extend_from_slice(take(&mut input, palette_size(header[10]))?);
    loop {
        let block = input;
        let keep = match take(&mut input, 1)?[0] {
            0x3b => {
                out.push(0x3b);
                return input.is_empty().then_some(out);
            }
            0x21 => take(&mut input, 1)?[0] != 0xfe,
            0x2c => {
                let descriptor = take(&mut input, 9)?;
                take(&mut input, palette_size(descriptor[8]) + 1)?; // Local palette and LZW code size.
                true
            }
            _ => return None,
        };
        loop {
            let size = take(&mut input, 1)?[0] as usize;
            if size == 0 {
                break;
            }
            take(&mut input, size)?;
        }
        if keep {
            out.extend_from_slice(&block[..block.len() - input.len()]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(format: ImageFormat) -> Vec<u8> {
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(3, 2)
            .write_to(&mut encoded, format)
            .unwrap();
        encoded.into_inner()
    }
    async fn check(raw: Vec<u8>, clean: Vec<u8>) {
        let source_hash = storage::hash(&raw);
        let (stored, info) = validate_image(raw.into(), true).await.unwrap();
        assert_eq!(stored.as_ref(), clean);
        assert_eq!(info.source_hash, source_hash);
        assert_eq!(info.hash, storage::hash(&stored));
        assert_ne!(info.hash, info.source_hash);
        let decoded = image::load_from_memory(&stored).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (3, 2));
    }
    #[tokio::test]
    async fn jpeg_strips_metadata_and_preserves_icc_and_scan() {
        fn segment(marker: u8, data: &[u8]) -> Vec<u8> {
            let mut s = vec![0xff, marker];
            s.extend(((data.len() + 2) as u16).to_be_bytes());
            s.extend(data);
            s
        }
        let mut clean = picture(ImageFormat::Jpeg);
        clean.splice(2..2, segment(0xe2, b"ICC_PROFILE\0\x01\x01profile"));
        let mut raw = clean.clone();
        let tags = [
            segment(0xe1, b"Exif\0\0GPS"),
            segment(0xed, b"IPTC"),
            segment(0xfe, b"comment"),
            segment(0xe2, b"other"),
        ]
        .concat();
        raw.splice(2..2, tags);
        check(raw, clean).await;
    }
    #[tokio::test]
    async fn png_strips_text_and_rejects_damaged_metadata() {
        let clean = picture(ImageFormat::Png);
        let mut raw = clean.clone();
        let data = b"tEXtComment\0GPS";
        let mut chunk = ((data.len() - 4) as u32).to_be_bytes().to_vec();
        chunk.extend_from_slice(data);
        let mut crc = flate2::Crc::new();
        crc.update(data);
        chunk.extend(crc.sum().to_be_bytes());
        let offset = 33; // Signature and IHDR.
        raw.splice(offset..offset, chunk);
        check(raw.clone(), clean).await;
        raw[offset + 8] ^= 1;
        let error = validate_image(raw.into(), true).await.err().unwrap();
        assert_eq!(
            (error.0, error.1.as_str()),
            (StatusCode::BAD_REQUEST, STRIP_ERROR)
        );
    }
    #[tokio::test]
    async fn webp_removes_odd_sized_chunks_flags_and_padding() {
        fn set_size(data: &mut [u8]) {
            let size = (data.len() - 8) as u32;
            data[4..8].copy_from_slice(&size.to_le_bytes());
        }
        let mut clean = picture(ImageFormat::WebP);
        clean.splice(12..12, *b"VP8X\x0a\0\0\0\0\0\0\0\x02\0\0\x01\0\0");
        set_size(&mut clean);
        let mut raw = clean.clone();
        raw[20] = 0x0c;
        raw.extend(b"EXIF\x03\0\0\0GPS\0XMP \x03\0\0\0xmp\0");
        set_size(&mut raw);
        check(raw, clean).await;
    }
    #[tokio::test]
    async fn gif_removes_only_comment_blocks() {
        let clean = picture(ImageFormat::Gif);
        let mut raw = clean.clone();
        let trailer = raw.len() - 1;
        raw.splice(trailer..trailer, *b"\x21\xfe\x03GPS\x02xy\0");
        check(raw, clean).await;
    }
    #[tokio::test]
    async fn truncated_containers_fail_closed() {
        for format in [
            ImageFormat::Jpeg,
            ImageFormat::Png,
            ImageFormat::WebP,
            ImageFormat::Gif,
        ] {
            let mut raw = picture(format);
            raw.pop();
            let e = validate_image(raw.into(), true).await.err().unwrap();
            assert_eq!((e.0, e.1.as_str()), (StatusCode::BAD_REQUEST, STRIP_ERROR));
        }
    }
}
