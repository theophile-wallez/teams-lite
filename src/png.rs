// A PNG encoder, for exactly one caller: the frames of the broker's sign-in window
// (see `src/xwindow.rs` and SIGN-IN.md).
//
// WHY IT IS HERE AND NOT A DEPENDENCY. A PNG is a zlib stream of filtered scanlines in
// four framed chunks, and this crate already carries both halves of that: `flate2` for
// the deflate and its `Crc` for the CRC-32 every chunk ends with. An image crate would
// bring a decoder, a dozen formats and a colour-management tree to write ~70 lines of
// framing — and the browser is the only reader, so the one format that matters is the one
// every `<img>` accepts.
//
// WHY PNG AND NOT RAW PIXELS. The frame travels as base64 in a JSON message, which is the
// idiom every other picture in this app already uses (an avatar, a custom emoji, a GitLab
// upload), so the page needs no decoder of its own and no second transport. A sign-in form
// is flat colour and horizontal type: filtered and deflated it is a fraction of its raw
// size, and the alternative (raw RGBA the page inflates itself with `DecompressionStream`)
// buys nothing and works in fewer browsers.

use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;

/// PNG's own eight-byte signature.
const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// Filter 0 (None) — the only choice for the first row, which has nothing above it.
const FILTER_NONE: u8 = 0;
/// Filter 2 (Up) — each byte less the byte above it. A screenshot is mostly flat bands,
/// so a row usually differs from the one above it in a handful of pixels, and the deflate
/// that follows compresses a field of zeroes to nearly nothing. Filter 1 (Sub) was the
/// other candidate and is worse here: horizontal type changes along a row far more often
/// than a row changes from its neighbour.
const FILTER_UP: u8 = 2;

/// Encode 8-bit RGB pixels (three bytes per pixel, row-major, no padding) as a PNG.
///
/// Refuses a buffer that is not exactly `width * height * 3` bytes rather than encoding a
/// truncated image: a frame one row short is a picture with a torn edge, and the caller
/// that built it has a bug worth hearing about.
pub fn encode_rgb(width: u32, height: u32, rgb: &[u8]) -> anyhow::Result<Vec<u8>> {
    let stride = width as usize * 3;
    let expected = stride * height as usize;
    anyhow::ensure!(width > 0 && height > 0, "a {width}x{height} picture has no pixels");
    anyhow::ensure!(
        rgb.len() == expected,
        "{}x{} needs {expected} bytes of RGB, got {}",
        width,
        height,
        rgb.len()
    );

    // Filter each row against the one above it, then deflate the lot as one zlib stream.
    let mut raw = Vec::with_capacity(expected + height as usize);
    for y in 0..height as usize {
        let row = &rgb[y * stride..(y + 1) * stride];
        if y == 0 {
            raw.push(FILTER_NONE);
            raw.extend_from_slice(row);
        } else {
            let above = &rgb[(y - 1) * stride..y * stride];
            raw.push(FILTER_UP);
            raw.extend(row.iter().zip(above).map(|(a, b)| a.wrapping_sub(*b)));
        }
    }
    let mut zlib = ZlibEncoder::new(Vec::new(), Compression::fast());
    zlib.write_all(&raw)?;
    let idat = zlib.finish()?;

    let mut out = Vec::with_capacity(idat.len() + 128);
    out.extend_from_slice(&SIGNATURE);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[
        8, // bit depth
        2, // colour type 2 = truecolour RGB, no alpha: a screenshot has nothing to blend
        0, // deflate, the only compression PNG defines
        0, // adaptive filtering, the only filter method PNG defines
        0, // no interlacing
    ]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &idat);
    chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

/// One PNG chunk: length, type, body, and the CRC-32 of the type and body together.
///
/// The CRC covers the TYPE as well as the data — the one detail of this format that a
/// reader silently rejects rather than complains about, which is why it has a test.
fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(body);
    out.extend_from_slice(&crc.sum().to_be_bytes());
}

/// Turn 32-bit Z_PIXMAP pixels into RGB, dropping the unused fourth byte.
///
/// The order is the X SERVER's, not this machine's, and it is asked for rather than assumed:
/// `msb_first` comes from the connection's own `image_byte_order`. A little-endian server hands
/// over B,G,R,X and a big-endian one X,R,G,B, and picking wrong produces a picture that looks
/// *almost* right — Microsoft's blue page reading as orange, with the number a reader has to
/// match drawn in the wrong ink — which is the kind of wrong that survives a review.
pub fn pixels_to_rgb(pixels: &[u8], msb_first: bool, out: &mut Vec<u8>) {
    for px in pixels.chunks_exact(4) {
        if msb_first {
            out.extend_from_slice(&[px[1], px[2], px[3]]);
        } else {
            out.extend_from_slice(&[px[2], px[1], px[0]]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::ZlibDecoder;
    use std::io::Read;

    /// Read a chunk stream back: (kind, body), checking every CRC on the way. A decoder in
    /// the tests rather than a golden file, because what has to hold is the FRAMING, and a
    /// golden PNG only proves that today's flate2 emits the same bytes as yesterday's.
    fn chunks(png: &[u8]) -> Vec<(String, Vec<u8>)> {
        assert_eq!(&png[..8], &SIGNATURE, "signature");
        let mut at = 8;
        let mut out = Vec::new();
        while at < png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            let kind = &png[at + 4..at + 8];
            let body = &png[at + 8..at + 8 + len];
            let stated = u32::from_be_bytes(png[at + 8 + len..at + 12 + len].try_into().unwrap());
            let mut crc = flate2::Crc::new();
            crc.update(kind);
            crc.update(body);
            assert_eq!(stated, crc.sum(), "CRC of {}", String::from_utf8_lossy(kind));
            out.push((String::from_utf8_lossy(kind).into_owned(), body.to_vec()));
            at += 12 + len;
        }
        out
    }

    #[test]
    fn the_frame_is_a_png_a_reader_can_walk() {
        let png = encode_rgb(2, 2, &[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]).unwrap();
        let parts = chunks(&png);
        let kinds: Vec<&str> = parts.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(kinds, ["IHDR", "IDAT", "IEND"]);
        let ihdr = &parts[0].1;
        assert_eq!(u32::from_be_bytes(ihdr[0..4].try_into().unwrap()), 2, "width");
        assert_eq!(u32::from_be_bytes(ihdr[4..8].try_into().unwrap()), 2, "height");
        assert_eq!(&ihdr[8..], &[8, 2, 0, 0, 0], "8-bit truecolour, deflate, no interlace");
    }

    #[test]
    fn the_pixels_survive_the_filter_and_the_deflate() {
        // The one thing an encoder can get wrong invisibly: filtered rows that do not
        // reconstruct. Undo Up here exactly as a decoder does, and compare with the input.
        let (w, h) = (3u32, 4u32);
        let rgb: Vec<u8> = (0..(w * h * 3) as u8).map(|b| b.wrapping_mul(37)).collect();
        let png = encode_rgb(w, h, &rgb).unwrap();
        let idat = chunks(&png).into_iter().find(|(k, _)| k == "IDAT").unwrap().1;
        let mut raw = Vec::new();
        ZlibDecoder::new(&idat[..]).read_to_end(&mut raw).unwrap();

        let stride = w as usize * 3;
        let mut decoded: Vec<u8> = Vec::with_capacity(rgb.len());
        for y in 0..h as usize {
            let (filter, row) = raw[y * (stride + 1)..(y + 1) * (stride + 1)].split_at(1);
            assert_eq!(filter[0], if y == 0 { FILTER_NONE } else { FILTER_UP });
            for (x, byte) in row.iter().enumerate() {
                let above = if y == 0 { 0 } else { decoded[(y - 1) * stride + x] };
                decoded.push(byte.wrapping_add(above));
            }
        }
        assert_eq!(decoded, rgb, "the picture did not survive the round trip");
    }

    #[test]
    fn a_buffer_of_the_wrong_size_is_refused_rather_than_torn() {
        assert!(encode_rgb(2, 2, &[0; 11]).is_err(), "one byte short");
        assert!(encode_rgb(2, 2, &[0; 13]).is_err(), "one byte long");
        assert!(encode_rgb(0, 5, &[]).is_err(), "no pixels at all");
    }

    #[test]
    fn a_pixel_follows_the_servers_own_byte_order() {
        // A blue pixel from a little-endian server: B=200, G=40, R=10, and a padding byte.
        let mut out = Vec::new();
        pixels_to_rgb(&[200, 40, 10, 255], false, &mut out);
        assert_eq!(out, vec![10, 40, 200], "red and blue are swapped");
        // The same pixel from a big-endian one: X,R,G,B.
        let mut msb = Vec::new();
        pixels_to_rgb(&[255, 10, 40, 200], true, &mut msb);
        assert_eq!(msb, vec![10, 40, 200], "the padding byte leads on an MSB-first server");
    }
}
