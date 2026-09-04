//! Minimal implementation of the Yjs sync + awareness wire protocol.
//!
//! This is deliberately hand-rolled on top of `lib0` variable-length integer
//! encoding so it stays compatible across `yrs` versions. It is wire-compatible
//! with the stock `y-websocket` / `y-protocols` JavaScript providers, which is
//! the whole point: unmodified Yjs clients connect to this server.
//!
//! Message layout (all integers are lib0 unsigned varints):
//!   [messageType] [ ...type-specific payload... ]
//!
//! messageType 0 = Sync:      [syncStep] [varUint8Array payload]
//!   syncStep 0 = SyncStep1:  payload = encoded state vector
//!   syncStep 1 = SyncStep2:  payload = update (state diff)
//!   syncStep 2 = Update:     payload = update
//! messageType 1 = Awareness: [varUint8Array awareness update]
//! messageType 3 = QueryAwareness (no payload)

pub const MSG_SYNC: u64 = 0;
pub const MSG_AWARENESS: u64 = 1;
pub const MSG_QUERY_AWARENESS: u64 = 3;

pub const SYNC_STEP1: u64 = 0;
pub const SYNC_STEP2: u64 = 1;
pub const SYNC_UPDATE: u64 = 2;

/// Write a lib0 unsigned variable-length integer (LEB128).
pub fn write_var_uint(buf: &mut Vec<u8>, mut num: u64) {
    loop {
        if num > 0x7f {
            buf.push(0x80 | (num as u8 & 0x7f));
            num >>= 7;
        } else {
            buf.push(num as u8 & 0x7f);
            break;
        }
    }
}

/// Read a lib0 unsigned variable-length integer, advancing `pos`.
pub fn read_var_uint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut num: u64 = 0;
    let mut shift: u32 = 0;
    loop {
        let byte = *buf.get(*pos)?;
        *pos += 1;
        num |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(num);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

/// Write a length-prefixed byte array.
pub fn write_var_u8_array(buf: &mut Vec<u8>, data: &[u8]) {
    write_var_uint(buf, data.len() as u64);
    buf.extend_from_slice(data);
}

/// Read a length-prefixed byte array, advancing `pos`.
pub fn read_var_u8_array<'a>(buf: &'a [u8], pos: &mut usize) -> Option<&'a [u8]> {
    let len = read_var_uint(buf, pos)? as usize;
    let start = *pos;
    let end = start.checked_add(len)?;
    if end > buf.len() {
        return None;
    }
    *pos = end;
    Some(&buf[start..end])
}

pub fn message_sync_step1(state_vector: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(state_vector.len() + 4);
    write_var_uint(&mut m, MSG_SYNC);
    write_var_uint(&mut m, SYNC_STEP1);
    write_var_u8_array(&mut m, state_vector);
    m
}

pub fn message_sync_step2(update: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(update.len() + 4);
    write_var_uint(&mut m, MSG_SYNC);
    write_var_uint(&mut m, SYNC_STEP2);
    write_var_u8_array(&mut m, update);
    m
}

pub fn message_sync_update(update: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(update.len() + 4);
    write_var_uint(&mut m, MSG_SYNC);
    write_var_uint(&mut m, SYNC_UPDATE);
    write_var_u8_array(&mut m, update);
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varuint_roundtrip() {
        for &n in &[0u64, 1, 127, 128, 255, 300, 16384, 1 << 20, u32::MAX as u64, u64::MAX] {
            let mut buf = Vec::new();
            write_var_uint(&mut buf, n);
            let mut pos = 0;
            assert_eq!(read_var_uint(&buf, &mut pos), Some(n), "roundtrip {n}");
            assert_eq!(pos, buf.len(), "consumed all bytes for {n}");
        }
    }

    #[test]
    fn var_u8_array_roundtrip() {
        let payload = b"hello yjs";
        let mut buf = Vec::new();
        write_var_u8_array(&mut buf, payload);
        let mut pos = 0;
        assert_eq!(read_var_u8_array(&buf, &mut pos), Some(&payload[..]));
        assert_eq!(pos, buf.len());
    }

    #[test]
    fn sync_step1_is_parseable() {
        let sv = b"\x00"; // a trivial (empty-ish) state vector payload
        let msg = message_sync_step1(sv);
        let mut pos = 0;
        assert_eq!(read_var_uint(&msg, &mut pos), Some(MSG_SYNC));
        assert_eq!(read_var_uint(&msg, &mut pos), Some(SYNC_STEP1));
        assert_eq!(read_var_u8_array(&msg, &mut pos), Some(&sv[..]));
    }

    #[test]
    fn truncated_array_is_none() {
        // length says 10 bytes but only 2 follow
        let mut buf = Vec::new();
        write_var_uint(&mut buf, 10);
        buf.extend_from_slice(b"ab");
        let mut pos = 0;
        assert_eq!(read_var_u8_array(&buf, &mut pos), None);
    }
}
